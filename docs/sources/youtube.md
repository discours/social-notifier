# YouTube

Видео канала читаются через YouTube Data API v3 ключом: плейлист «Загрузки» канала, новые видео первыми.

**Что нужно:** ключ API в Google Cloud. **Цена:** бесплатно. Каждый запуск тратит 2 единицы квоты: около 290 в сутки из бесплатных 10 000.

У канала есть и RSS (`https://www.youtube.com/feeds/videos.xml?channel_id=…`) без ключа, и его можно подключить как [ленту](feed.md). Но в ноябре 2026 он отвечал 404 даже официальным каналам, поэтому основной путь — API.

## Ключ

1. В [Google Cloud Console](https://console.cloud.google.com/) создайте проект или выберите существующий.
2. **APIs & Services** → **Library** → **YouTube Data API v3** → **Enable**.
3. **APIs & Services** → **Credentials** → **Create credentials** → **API key**.
4. У ключа нажмите **Edit API key** → **API restrictions** → **Restrict key** → только **YouTube Data API v3**. Тогда утёкший ключ не откроет другие API проекта.
5. Сохраните ключ:

   ```bash
   gh secret set YOUTUBE_API_KEY --repo OWNER/REPO
   ```

То же из командной строки, если стоит [gcloud](https://cloud.google.com/sdk/docs/install). Ключ уходит из Google Cloud прямо в секрет и не появляется на экране. Флаг `--async` у `create` обязателен: без него gcloud печатает ответ целиком, вместе с самим ключом.

```bash
gcloud services enable youtube.googleapis.com --project PROJECT
gcloud services api-keys create --async --project PROJECT --display-name="social-notifier YouTube" --api-target=service=youtube.googleapis.com
gcloud services api-keys list --project PROJECT --format="value(displayName,name.basename())"
gcloud services api-keys get-key-string KEY_ID --project PROJECT --format="value(keyString)" | gh secret set YOUTUBE_API_KEY --repo OWNER/REPO
```

`KEY_ID` — вторая колонка вывода `list`. С `--async` gcloud не ждёт создания ключа: если нового ключа в списке ещё нет, повторите `list` через несколько секунд.

`KEY_ID` — вторая колонка вывода `list` у ключа `social-notifier YouTube`.

Радар передаёт ключ в заголовке `x-goog-api-key`, не в адресе запроса.

## Источник в конфиге

```json
{ "id": "youtube", "type": "youtube", "label": "YouTube", "channelId": "UCXEydGIYsqj-fjDnqAOXNNg" }
```

`channelId` — ID канала: `UC` и ещё 22 символа. Он виден в адресе вида `youtube.com/channel/UC…`. Если в адресе канала `@имя`, откройте описание канала → **Поделиться**: там есть пункт, копирующий идентификатор канала.

## Что приходит

- Публичные видео, Shorts и записи трансляций канала. Время — когда видео стало публичным.
- Приватные видео и видео, доступные по ссылке, не приходят.
- Признака Shorts в API нет: они приходят как обычные видео.
