import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runRadar, KEEPALIVE_AFTER_MS, type RadarDeps } from '../src/radar.ts';
import { emptyState, type RadarState } from '../src/state.ts';
import { FakeWorld, HOUR, MINUTE, PAGE_TOKEN, SECRETS, json, redact, testConfig } from './helpers.ts';

const T0 = Date.UTC(2026, 10, 7, 12, 0, 0);

function deps(world: FakeWorld, now: number, extra: Partial<RadarDeps> = {}): RadarDeps {
  return {
    config: testConfig(),
    secrets: SECRETS,
    fetch: world.fetch,
    now: () => now,
    log: () => {},
    redact,
    sleep: async () => {},
    ...extra,
  };
}

/** Мир с тремя старыми постами и пройденным первым запуском. */
async function bootstrapped(): Promise<{ world: FakeWorld; state: RadarState }> {
  const world = new FakeWorld();
  world.addVk(100, T0 - 5 * HOUR);
  world.addFb('1_1', T0 - 4 * HOUR);
  world.addIg('9001', T0 - 3 * HOUR);
  const state = emptyState();
  const result = await runRadar(state, deps(world, T0 - 30 * MINUTE));
  assert.equal(result.exitCode, 0);
  world.sent = [];
  world.calls = [];
  return { world, state };
}

describe('runRadar: первый запуск', () => {
  it('запоминает текущие посты и ничего не отправляет', async () => {
    const world = new FakeWorld();
    world.addVk(100, T0 - HOUR);
    world.addFb('1_1', T0 - HOUR);
    world.addIg('9001', T0 - HOUR);
    const state = emptyState();

    const result = await runRadar(state, deps(world, T0));

    assert.equal(result.exitCode, 0);
    assert.equal(world.sent.length, 0);
    assert.deepEqual(state.pending, []);
    assert.deepEqual(state.sources.vk?.seen, ['100']);
    assert.deepEqual(state.sources.facebook?.seen, ['1_1']);
    assert.deepEqual(state.sources.instagram?.seen, ['9001']);
    assert.equal(state.sources.vk?.bootstrapped, true);
  });
});

describe('runRadar: группировка', () => {
  it('посты трёх сетей в пределах окна уходят одним сообщением', async () => {
    const { world, state } = await bootstrapped();

    world.addVk(101, T0, 'Дом — это люди');
    await runRadar(state, deps(world, T0 + 1 * MINUTE));
    assert.equal(world.sent.length, 0, 'окно ещё открыто');
    assert.equal(state.pending.length, 1);

    world.addIg('9002', T0 + 3 * MINUTE, 'Дом — это люди (IG)');
    world.addFb('1_2', T0 + 7 * MINUTE, 'Пятеро детей — не повод');
    await runRadar(state, deps(world, T0 + 8 * MINUTE));
    assert.equal(world.sent.length, 0, 'окно ещё открыто');
    assert.equal(state.pending.length, 3);

    const result = await runRadar(state, deps(world, T0 + 10 * MINUTE));
    assert.equal(result.postsSent, 3);
    const messages = world.postsMessages();
    assert.equal(messages.length, 1, 'ровно одно сообщение');
    const text = messages[0] ?? '';
    assert.ok(text.startsWith('Новые посты:'));
    // порядок — по времени публикации
    assert.ok(text.indexOf('<b>VK</b>') < text.indexOf('<b>Instagram</b>'));
    assert.ok(text.indexOf('<b>Instagram</b>') < text.indexOf('<b>Facebook</b>'));
    assert.ok(text.includes('href="https://vk.com/wall-89236419_101"'));
    assert.equal(world.sent[0]?.previewDisabled, true, 'у нескольких постов превью выключено');
    assert.deepEqual(state.pending, []);
  });

  it('пост, найденный с опозданием, уходит сразу', async () => {
    const { world, state } = await bootstrapped();
    world.addVk(101, T0 - 30 * MINUTE);

    await runRadar(state, deps(world, T0));

    assert.equal(world.postsMessages().length, 1);
    assert.equal(world.sent[0]?.previewDisabled, false, 'у одного поста превью есть');
  });

  it('пост виден повторно — второй раз в очередь не встаёт', async () => {
    const { world, state } = await bootstrapped();
    world.addVk(101, T0);
    await runRadar(state, deps(world, T0 + MINUTE));
    await runRadar(state, deps(world, T0 + 2 * MINUTE));
    assert.equal(state.pending.length, 1);

    await runRadar(state, deps(world, T0 + 11 * MINUTE));
    await runRadar(state, deps(world, T0 + 21 * MINUTE));
    assert.equal(world.postsMessages().length, 1, 'пост отправлен один раз');
  });

  it('пост в очереди, выпавший из списка виденных, второй раз в очередь не встаёт', async () => {
    const { world, state } = await bootstrapped();
    world.addVk(101, T0);
    await runRadar(state, deps(world, T0 + MINUTE));
    assert.equal(state.pending.length, 1);
    const vk = state.sources.vk;
    assert.ok(vk);
    vk.seen = vk.seen.filter((id) => id !== '101'); // как после усечения до SEEN_LIMIT

    await runRadar(state, deps(world, T0 + 2 * MINUTE));

    assert.equal(state.pending.length, 1);
  });

  it('старый пост, впервые попавший в выдачу, не присылается', async () => {
    const { world, state } = await bootstrapped();
    world.addVk(50, T0 - 72 * HOUR, 'старый пост из архива');

    await runRadar(state, deps(world, T0));
    await runRadar(state, deps(world, T0 + 20 * MINUTE));

    assert.equal(world.sent.length, 0);
    assert.ok(state.sources.vk?.seen.includes('50'), 'но запомнен, чтобы не всплыть снова');
  });

  it('пост после начала наблюдения, впервые увиденный старше 48 ч, не присылается', async () => {
    const { world, state } = await bootstrapped(); // наблюдение с T0 − 30 мин
    world.addVk(101, T0, 'вышел, пока расписание стояло');
    world.addVk(102, T0 + 48 * HOUR, 'свежий');

    await runRadar(state, deps(world, T0 + 49 * HOUR)); // радар не запускался двое суток

    const messages = world.postsMessages();
    assert.equal(messages.length, 1);
    assert.ok(messages[0]?.includes('wall-89236419_102"'), 'свежий прислан');
    assert.ok(!messages[0]?.includes('wall-89236419_101"'), 'старше порога — нет');
    assert.ok(state.sources.vk?.seen.includes('101'), 'но запомнен');
  });

  it('выросла выдача: пост до начала наблюдения не присылается, хотя радар видит его впервые', async () => {
    const { world, state } = await bootstrapped(); // наблюдение с T0 − 30 мин
    // Как после подъёма fetchLimit: в выдаче появился пост моложе 48 ч, но
    // вышедший до начала наблюдения — о нём уже сообщали до радара.
    world.vk.push({ id: 99, date: Math.floor((T0 - 6 * HOUR) / 1000), text: 'до начала наблюдения' });
    world.addVk(101, T0, 'новый');

    await runRadar(state, deps(world, T0 + 10 * MINUTE));

    const messages = world.postsMessages();
    assert.equal(messages.length, 1);
    assert.ok(messages[0]?.includes('wall-89236419_101"'), 'новый пост прислан');
    assert.ok(!messages[0]?.includes('wall-89236419_99"'), 'архив не прислан');
    assert.ok(state.sources.vk?.seen.includes('99'), 'архив запомнен, чтобы не всплыть снова');
  });

  it('источник без отметки начала наблюдения присылает новые посты', async () => {
    const { world, state } = await bootstrapped();
    const vk = state.sources.vk;
    assert.ok(vk);
    delete vk.watchingSince; // состояние поправили руками
    world.addVk(101, T0);

    await runRadar(state, deps(world, T0 + 10 * MINUTE));

    assert.equal(world.postsMessages().length, 1);
  });

  it('лог называет задержку от публикации до отправки', async () => {
    const { world, state } = await bootstrapped();
    world.addVk(101, T0);
    world.addFb('1_2', T0 + 4 * MINUTE);
    const lines: string[] = [];

    await runRadar(state, deps(world, T0 + 12 * MINUTE, { log: (l) => lines.push(l) }));
    world.addIg('9002', T0 + 20 * MINUTE);
    await runRadar(state, deps(world, T0 + 30 * MINUTE, { log: (l) => lines.push(l) }));

    assert.ok(lines.includes('отправлено постов: 2, сообщений: 1; от публикации до отправки: 8–12 мин'), lines.join('\n'));
    assert.ok(lines.includes('отправлено постов: 1, сообщений: 1; от публикации до отправки: 10 мин'), lines.join('\n'));
  });
});

describe('runRadar: алерты', () => {
  it('сбой источника: тишина на первом, алерт на втором, повтор через сутки, сообщение о починке', async () => {
    const { world, state } = await bootstrapped();
    world.fail.graph = json({ error: { code: 190, message: 'Error validating access token: session invalidated' } }, 400);

    const first = await runRadar(state, deps(world, T0));
    assert.equal(first.exitCode, 0, 'разовый сбой не красит запуск');
    assert.equal(world.alertMessages().length, 0);

    const second = await runRadar(state, deps(world, T0 + 10 * MINUTE));
    assert.equal(second.exitCode, 1, 'запуск с алертом красный');
    const alerts = world.alertMessages();
    assert.equal(alerts.length, 2, 'по алерту на Instagram и Facebook');
    assert.ok(alerts[0]?.includes('<code>auth</code>'));
    assert.ok(alerts[0]?.includes('META_TOKEN'));
    assert.equal(world.postsMessages().length, 0, 'алерты не идут в чат постов');

    const third = await runRadar(state, deps(world, T0 + 20 * MINUTE));
    assert.equal(third.exitCode, 0, 'в пределах суток без повтора');
    assert.equal(world.alertMessages().length, 2);

    await runRadar(state, deps(world, T0 + 10 * MINUTE + 24 * HOUR));
    assert.equal(world.alertMessages().length, 4, 'через сутки повтор');

    delete world.fail.graph;
    await runRadar(state, deps(world, T0 + 25 * HOUR));
    const recovery = world.alertMessages().slice(4);
    assert.equal(recovery.length, 2);
    assert.ok(recovery.every((m) => m.includes('снова читаются')));
    assert.equal(state.sources.facebook?.consecutiveFailures, 0);
    assert.equal(state.sources.facebook?.alertOpen, undefined, 'уведомление о починке доставлено');
  });

  it('мигающий источник: один алерт, одно «снова читаются» и один красный запуск за сутки', async () => {
    const { world, state } = await bootstrapped();
    const broken = json({ error: { code: 2, message: 'Service temporarily unavailable' } }, 500);
    let reds = 0;
    // 3 часа: сбой, сбой, успех — и так по кругу
    for (let i = 0; i < 18; i += 1) {
      if (i % 3 === 2) delete world.fail.graph;
      else world.fail.graph = broken;
      reds += (await runRadar(state, deps(world, T0 + i * 10 * MINUTE))).exitCode;
    }
    assert.equal(reds, 1);
    const alerts = world.alertMessages();
    assert.equal(alerts.filter((m) => m.includes('не читаются')).length, 2, 'по алерту на Instagram и Facebook');
    assert.equal(alerts.filter((m) => m.includes('снова читаются')).length, 2);
  });

  it('часть ответа не разобралась — разобранное доходит, а повтор даёт алерт', async () => {
    const { world, state } = await bootstrapped();
    world.addIg('9002', T0 - 20 * MINUTE);
    world.ig.unshift({ id: '9003', timestamp: 'новый формат даты', permalink: 'https://www.instagram.com/p/9003/' });

    await runRadar(state, deps(world, T0));
    assert.equal(world.postsMessages().length, 1, 'разобранный пост отправлен');
    assert.equal(world.alertMessages().length, 0, 'один раз — ещё не повод');

    await runRadar(state, deps(world, T0 + 10 * MINUTE));
    const alerts = world.alertMessages();
    assert.equal(alerts.length, 1);
    assert.ok(alerts[0]?.includes('не разобрано элементов ответа: 1 из'));
    assert.match(alerts[0] ?? '', /: часть постов не читается, /, 'алерт не обещает потерю всего');
    assert.match(alerts[0] ?? '', /Разобранные посты приходят как обычно\./);
  });

  it('источник, сломанный с первого запуска, после починки присылает посты, вышедшие за это время', async () => {
    const world = new FakeWorld();
    world.addVk(100, T0 - 5 * HOUR, 'старый пост');
    world.fail.vk = json({ error: { error_code: 5, error_msg: 'User authorization failed' } });
    const state = emptyState();
    await runRadar(state, deps(world, T0));
    await runRadar(state, deps(world, T0 + 10 * MINUTE));

    world.addVk(101, T0 + 2 * HOUR, 'вышел, пока ключ был сломан');
    delete world.fail.vk;
    await runRadar(state, deps(world, T0 + 3 * HOUR));
    await runRadar(state, deps(world, T0 + 3 * HOUR + 10 * MINUTE));

    const text = world.postsMessages().join('\n');
    assert.ok(text.includes('wall-89236419_101"'), 'пост, вышедший после начала наблюдения, доставлен');
    assert.ok(!text.includes('wall-89236419_100"'), 'архив не прислан');
  });

  it('VK продолжает работать, пока Meta сломана', async () => {
    const { world, state } = await bootstrapped();
    world.fail.graph = new TypeError('fetch failed');
    world.addVk(101, T0 - 20 * MINUTE);

    await runRadar(state, deps(world, T0));

    assert.equal(world.postsMessages().length, 1);
    assert.equal(state.sources.instagram?.lastError?.kind, 'network');
  });

  it('Telegram недоступен: очередь сохраняется, красный запуск не чаще раза в сутки', async () => {
    const { world, state } = await bootstrapped();
    world.addVk(101, T0 - 20 * MINUTE);
    world.fail.telegram = json({ ok: false, error_code: 401, description: 'Unauthorized' }, 401);

    const first = await runRadar(state, deps(world, T0));
    assert.equal(first.exitCode, 1);
    assert.equal(state.pending.length, 1, 'пост остался в очереди');

    const second = await runRadar(state, deps(world, T0 + 10 * MINUTE));
    assert.equal(second.exitCode, 0, 'второй красный запуск в те же сутки не нужен');

    delete world.fail.telegram;
    const third = await runRadar(state, deps(world, T0 + 20 * MINUTE));
    assert.equal(third.exitCode, 0);
    assert.equal(world.postsMessages().length, 1);
    assert.deepEqual(state.pending, []);
    assert.equal(state.telegram?.consecutiveFailures, 0);
  });

  it('текст ошибки API с токеном не попадает ни в состояние, ни в алерт', async () => {
    const { world, state } = await bootstrapped();
    world.fail.graph = json({ error: { code: 190, message: `Malformed access token ${SECRETS.META_TOKEN}` } }, 400);

    await runRadar(state, deps(world, T0));
    await runRadar(state, deps(world, T0 + 10 * MINUTE));

    const stored = JSON.stringify(state);
    assert.ok(!stored.includes(SECRETS.META_TOKEN ?? '-'), 'нет в состоянии');
    const alerts = world.alertMessages();
    assert.equal(alerts.length, 2, 'алерты дошли — проверка ниже не пустая');
    assert.ok(alerts.every((m) => !m.includes(SECRETS.META_TOKEN ?? '-')), 'нет в алерте');
    assert.ok(alerts.every((m) => m.includes('[секрет]')), 'текст ошибки сохранился, вычищен только токен');
    assert.ok(stored.includes('[секрет]'));
  });

  it('чат алертов не принимает сообщения: алерт повторяется, но красный запуск — раз в сутки', async () => {
    const { world, state } = await bootstrapped();
    world.fail.graph = json({ error: { code: 190, message: 'session invalidated' } }, 400);
    world.blockedChats.add(SECRETS.TELEGRAM_ALERT_CHAT_ID ?? '-');

    const codes: number[] = [];
    for (let i = 0; i < 6; i += 1) codes.push((await runRadar(state, deps(world, T0 + i * 10 * MINUTE))).exitCode);
    assert.deepEqual(codes, [0, 1, 0, 0, 0, 0]);
    assert.equal(world.alertMessages().length, 0);

    world.blockedChats.clear();
    await runRadar(state, deps(world, T0 + 60 * MINUTE));
    assert.equal(world.alertMessages().length, 2, 'алерт дошёл, как только чат открылся');

    const later = await runRadar(state, deps(world, T0 + 25 * HOUR));
    assert.equal(later.exitCode, 1, 'через сутки поломка снова красит запуск');
  });

  it('чат алертов не принимает сообщения, источник мигает: красный запуск всё равно раз в сутки', async () => {
    const { world, state } = await bootstrapped();
    const broken = json({ error: { code: 2, message: 'Service temporarily unavailable' } }, 500);
    world.blockedChats.add(SECRETS.TELEGRAM_ALERT_CHAT_ID ?? '-');
    const codes: number[] = [];
    // 6 часов: сбой, сбой, успех — запуски без отправки не доказывают, что Telegram починился
    for (let i = 0; i < 36; i += 1) {
      if (i % 3 === 2) delete world.fail.graph;
      else world.fail.graph = broken;
      codes.push((await runRadar(state, deps(world, T0 + i * 10 * MINUTE))).exitCode);
    }
    assert.equal(codes.filter((c) => c === 1).length, 1, `красные запуски: ${codes.join('')}`);
    assert.equal(world.alertMessages().length, 0, 'проверка не пустая: чат действительно закрыт');
  });

  it('уведомление о починке не теряется, если Telegram в этот момент недоступен', async () => {
    const { world, state } = await bootstrapped();
    world.fail.graph = json({ error: { code: 190, message: 'session invalidated' } }, 400);
    await runRadar(state, deps(world, T0));
    await runRadar(state, deps(world, T0 + 10 * MINUTE));
    assert.equal(world.alertMessages().length, 2);

    delete world.fail.graph;
    world.blockedChats.add(SECRETS.TELEGRAM_ALERT_CHAT_ID ?? '-');
    await runRadar(state, deps(world, T0 + 20 * MINUTE));
    assert.equal(world.alertMessages().length, 2, 'Telegram недоступен — уведомление не ушло');

    world.blockedChats.clear();
    await runRadar(state, deps(world, T0 + 30 * MINUTE));
    const recovery = world.alertMessages().slice(2);
    assert.equal(recovery.length, 2);
    assert.ok(recovery.every((m) => m.includes('снова читаются')));

    await runRadar(state, deps(world, T0 + 40 * MINUTE));
    assert.equal(world.alertMessages().length, 4, 'и не повторяется после доставки');
  });

  it('Instagram поменял формат ответа — это сбой источника, а не тишина', async () => {
    const { world, state } = await bootstrapped();
    world.ig = [{ id: 'не число', timestamp: 'вчера', permalink: 'https://www.instagram.com/p/x/' }];

    await runRadar(state, deps(world, T0));
    await runRadar(state, deps(world, T0 + 10 * MINUTE));

    assert.equal(state.sources.instagram?.lastError?.kind, 'bad_response');
    assert.equal(world.alertMessages().length, 1);
  });
});

describe('runRadar: длинный дайджест', () => {
  it('Telegram отказал посередине — повторяется только недоставленный остаток', async () => {
    const { world, state } = await bootstrapped();
    for (let i = 0; i < 40; i += 1) world.addVk(200 + i, T0 - 30 * MINUTE + i * 1000, `Длинный заголовок поста ${i} `.repeat(6));
    world.telegramFailOnCall.add(2);

    const lines: string[] = [];
    const first = await runRadar(state, deps(world, T0, { log: (l) => lines.push(l) }));
    assert.equal(first.exitCode, 1);
    const delivered = first.postsSent;
    assert.ok(delivered > 0 && delivered < 40, `первое сообщение ушло (${delivered} постов), второе нет`);
    assert.equal(state.pending.length, 40 - delivered, 'с очереди сняты только доставленные');
    const stuck = lines.find((l) => l.startsWith('не доставлено сообщение с постами: '));
    assert.ok(stuck, 'лог называет посты недоставленного сообщения');
    assert.ok(stuck.includes(`vk:${200 + delivered}`), 'первым назван первый недоставленный пост');
    assert.ok(!stuck.includes(`vk:${200 + delivered - 1},`) && !stuck.endsWith(`vk:${200 + delivered - 1}`), 'доставленные не названы');

    await runRadar(state, deps(world, T0 + 10 * MINUTE));
    const text = world.postsMessages().join('\n');
    for (let i = 0; i < 40; i += 1) {
      const occurrences = text.split(`wall-89236419_${200 + i}"`).length - 1;
      assert.equal(occurrences, 1, `пост ${200 + i} доставлен ровно один раз`);
    }
    assert.deepEqual(state.pending, []);
  });

  it('один и тот же пост дважды в ответе API — одна строка в сообщении', async () => {
    const { world, state } = await bootstrapped();
    world.addVk(101, T0 - 20 * MINUTE);
    world.addVk(101, T0 - 20 * MINUTE);

    await runRadar(state, deps(world, T0));

    const text = world.postsMessages().join('\n');
    assert.equal(text.split('wall-89236419_101"').length - 1, 1);
  });
});

describe('runRadar: секреты в запросах', () => {
  it('токены VK и Meta не попадают в адрес запроса', async () => {
    const world = new FakeWorld();
    world.addVk(1, T0);
    await runRadar(emptyState(), deps(world, T0));

    const vk = world.calls.filter((c) => c.url.includes('api.vk.com'));
    const graph = world.calls.filter((c) => c.url.includes('graph.facebook.com'));
    assert.equal(vk.length, 1);
    assert.equal(graph.length, 4, 'токен страницы, посты FB, аккаунт IG, медиа IG');
    for (const call of [...vk, ...graph]) {
      for (const secret of [SECRETS.VK_TOKEN, SECRETS.META_TOKEN, PAGE_TOKEN]) assert.ok(!call.url.includes(secret ?? '-'));
      assert.ok(!new URL(call.url).searchParams.has('access_token'));
    }
    assert.equal(vk[0]?.method, 'POST');
    assert.ok(new URLSearchParams(vk[0]?.body).get('access_token') === SECRETS.VK_TOKEN);
    for (const call of graph) {
      const expected = new URL(call.url).pathname.endsWith('/posts') ? PAGE_TOKEN : SECRETS.META_TOKEN;
      assert.equal(call.headers.authorization, `Bearer ${expected}`, call.url);
    }
  });
});

describe('runRadar: служебное', () => {
  it('dry-run ничего не отправляет', async () => {
    const { world, state } = await bootstrapped();
    world.addVk(101, T0 - 20 * MINUTE);
    const lines: string[] = [];

    await runRadar(state, deps(world, T0, { dryRun: true, log: (l) => lines.push(l) }));

    assert.equal(world.calls.filter((c) => c.url.includes('telegram')).length, 0);
    assert.ok(lines.some((l) => l.startsWith('[dry-run] в чат:')));
  });

  it('keepalive меняется раз в 25 дней, а не каждый запуск', async () => {
    const { world, state } = await bootstrapped();
    const first = state.keepaliveAt;
    assert.equal(typeof first, 'number');

    await runRadar(state, deps(world, T0));
    assert.equal(state.keepaliveAt, first, 'тихий запуск состояние не меняет');

    const later = (first ?? 0) + KEEPALIVE_AFTER_MS;
    await runRadar(state, deps(world, later));
    assert.equal(state.keepaliveAt, later);
  });

  it('тихий запуск без новых постов не меняет состояние', async () => {
    const { world, state } = await bootstrapped();
    const before = JSON.stringify(state);
    await runRadar(state, deps(world, T0));
    assert.equal(JSON.stringify(state), before);
  });
});
