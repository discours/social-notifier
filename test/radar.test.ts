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
    assert.ok(recovery.every((m) => m.includes('снова отвечает')));
    assert.equal(state.sources.facebook?.consecutiveFailures, 0);
    assert.equal(state.sources.facebook?.alertedAt, undefined);
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
    world.fail.graph = json({ error: { code: 190, message: `Malformed access token ${SECRETS.metaToken}` } }, 400);

    await runRadar(state, deps(world, T0));
    await runRadar(state, deps(world, T0 + 10 * MINUTE));

    const stored = JSON.stringify(state);
    assert.ok(!stored.includes(SECRETS.metaToken ?? '-'), 'нет в состоянии');
    const alerts = world.alertMessages();
    assert.equal(alerts.length, 2, 'алерты дошли — проверка ниже не пустая');
    assert.ok(alerts.every((m) => !m.includes(SECRETS.metaToken ?? '-')), 'нет в алерте');
    assert.ok(alerts.every((m) => m.includes('[секрет]')), 'текст ошибки сохранился, вычищен только токен');
    assert.ok(stored.includes('[секрет]'));
  });

  it('чат алертов не принимает сообщения: алерт повторяется, но красный запуск — раз в сутки', async () => {
    const { world, state } = await bootstrapped();
    world.fail.graph = json({ error: { code: 190, message: 'session invalidated' } }, 400);
    world.blockedChats.add(SECRETS.telegramAlertChatId ?? '-');

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

  it('уведомление о починке не теряется, если Telegram в этот момент недоступен', async () => {
    const { world, state } = await bootstrapped();
    world.fail.graph = json({ error: { code: 190, message: 'session invalidated' } }, 400);
    await runRadar(state, deps(world, T0));
    await runRadar(state, deps(world, T0 + 10 * MINUTE));
    assert.equal(world.alertMessages().length, 2);

    delete world.fail.graph;
    world.blockedChats.add(SECRETS.telegramAlertChatId ?? '-');
    await runRadar(state, deps(world, T0 + 20 * MINUTE));
    assert.equal(world.alertMessages().length, 2, 'Telegram недоступен — уведомление не ушло');

    world.blockedChats.clear();
    await runRadar(state, deps(world, T0 + 30 * MINUTE));
    const recovery = world.alertMessages().slice(2);
    assert.equal(recovery.length, 2);
    assert.ok(recovery.every((m) => m.includes('снова отвечает')));

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

    const first = await runRadar(state, deps(world, T0));
    assert.equal(first.exitCode, 1);
    const delivered = first.postsSent;
    assert.ok(delivered > 0 && delivered < 40, `первое сообщение ушло (${delivered} постов), второе нет`);
    assert.equal(state.pending.length, 40 - delivered, 'с очереди сняты только доставленные');

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
      for (const secret of [SECRETS.vkToken, SECRETS.metaToken, PAGE_TOKEN]) assert.ok(!call.url.includes(secret ?? '-'));
      assert.ok(!new URL(call.url).searchParams.has('access_token'));
    }
    assert.equal(vk[0]?.method, 'POST');
    assert.ok(new URLSearchParams(vk[0]?.body).get('access_token') === SECRETS.vkToken);
    for (const call of graph) {
      const expected = new URL(call.url).pathname.endsWith('/posts') ? PAGE_TOKEN : SECRETS.metaToken;
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
