# RSS и Atom

Любая лента RSS 2.0 или Atom 1.0 по открытому адресу: Mastodon, Substack, блоги, подкасты, релизы на GitHub.

**Что нужно:** адрес ленты, только `https`. **Цена:** бесплатно.

## Источник в конфиге

```json
[
  { "id": "mastodon", "type": "feed", "label": "Mastodon", "url": "https://mastodon.social/@Mastodon.rss" },
  { "id": "substack", "type": "feed", "label": "Substack", "url": "https://example.substack.com/feed" }
]
```

Адрес лежит в публичном конфиге, поэтому логин и пароль в нём запрещены. Закрытые ленты не поддерживаются. Если лента перенаправляет на адрес без `https` или весит больше 10 МБ, радар её не читает и присылает алерт.

## Где взять адрес

| Площадка | Адрес ленты |
| --- | --- |
| Mastodon | `https://<сервер>/@<имя>.rss` |
| Substack | `https://<имя>.substack.com/feed` |
| WordPress | `https://<сайт>/feed/` |
| YouTube | `https://www.youtube.com/feeds/videos.xml?channel_id=UC…` (ненадёжно, см. [YouTube](youtube.md)) |
| GitHub, релизы | `https://github.com/<владелец>/<репозиторий>/releases.atom` |

## Что приходит

- Текст сообщения — заголовок записи. У лент без заголовков (Mastodon) — первая строка описания без HTML.
- Ссылка — `<link>` записи, иначе `<guid>` с адресом, а у подкастов без того и другого — файл выпуска из `<enclosure>`. Время — `pubDate` у RSS, `published` (иначе `updated`) у Atom.
- Из длинной ленты берутся `fetchLimit` самых свежих записей.
- Запись без даты или без ссылки не разбирается и считается сбоем ленты: со второго такого запуска приходит алерт. Старая запись, которая и так не попала бы в `fetchLimit` свежих, сбоем не считается.
