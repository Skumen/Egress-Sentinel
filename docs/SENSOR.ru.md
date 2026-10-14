# Сенсор трафика Egress Sentinel (VLESS)

[English version](SENSOR.md)

Сенсор проверяет, что трафик через выходные узлы действительно проходит. Открытого порта для этого мало. Раз в минуту сенсор:

1. Проверяет свой прямой интернет (`canaries`): должны отвечать все адреса, и местный, и зарубежный. Если какой-то не отвечает (например, у сервера пропал зарубежный канал), сенсор сообщает, что неисправен сам. Узлы из-за этого **не** объявляются недоступными.
2. Через локальный Xray подключается к каждому узлу по его ссылке `vless://`, как обычный клиент.
3. Открывает через туннель проверочный адрес (`probeUrl`) и узнаёт выходной IP (`ipUrl`).
4. Отправляет результаты мониторингу: `POST https://<панель>/api/sensor/report` с токеном сенсора.

Если узел отвечает на прямую проверку, а трафик через него не проходит, мониторинг поднимает обычную тревогу с пометкой `VLESS traffic not passing (sensor …)`.

**Где запускать.** На отдельном сервере: не на сервере мониторинга и не на одном из узлов. Лучше всего VPS в регионе ваших пользователей: тогда сенсор заметит и блокировки у провайдеров.

**Что нужно.** Linux-сервер с Node.js 20+, curl и Xray-core. Входящие порты не нужны, только исходящие соединения.

Поддерживаются ссылки из 3x-ui, Marzban, Remnawave, v2rayN и подобных панелей:

| Параметр | Варианты |
|---|---|
| Транспорт `type` | `tcp` / `raw`, `ws`, `grpc`, `xhttp` / `splithttp`, `httpupgrade`, `kcp` |
| Шифрование `security` | `reality`, `tls`, `none` |
| Прочее | `flow=xtls-rprx-vision` |

---

## Шаг 1. Подготовьте узлы (рекомендуется)

Создайте на каждом VLESS-сервере **отдельного клиента для сенсора**, например `sentinel-sensor`, и скопируйте его ссылку `vless://…`. Так проверки не расходуют трафик настоящих пользователей, а доступ сенсора можно отозвать отдельно.

## Шаг 2. Зарегистрируйте сенсор в панели

В мини-приложении откройте **Administration → Traffic sensors**.

1. Введите имя сенсора (например, `MSK-1`) и нажмите **Register sensor and issue token**.
2. Скопируйте токен. **Он показывается один раз.** Если потеряете, нажмите **Issue new token**.
3. Внизу экрана, в блоке **Exit node IDs**, лежат ID узлов (8 символов). Они нужны для конфигурации.

## Шаг 3. Установите Node.js, curl и Xray

На сервере сенсора от root:

```bash
apt update && apt install -y curl ca-certificates unzip
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs
node -v
```

Xray-core ставится из официального релиза. Пример для v26.3.27:

```bash
cd /tmp
curl -fLO https://github.com/XTLS/Xray-core/releases/download/v26.3.27/Xray-linux-64.zip
curl -fLO https://github.com/XTLS/Xray-core/releases/download/v26.3.27/Xray-linux-64.zip.dgst
grep SHA2-256 Xray-linux-64.zip.dgst
sha256sum Xray-linux-64.zip
```

Две контрольные суммы должны совпасть. Затем:

```bash
unzip -o Xray-linux-64.zip xray -d /usr/local/bin/
chmod 755 /usr/local/bin/xray
xray version
```

Для серверов на ARM скачайте `Xray-linux-arm64-v8a.zip`.

Если Xray на этом сервере уже установлен для других задач, ставить его заново не нужно. Сенсор запускает свой отдельный процесс Xray и слушает только `127.0.0.1:20800` и следующие порты, поэтому существующий Xray не затрагивает.

## Шаг 4. Скопируйте сенсор на сервер

**На своём компьютере** загрузите архив релиза:

```bash
scp egress-sentinel.zip root@<сервер-сенсора>:/tmp/
```

**На сервере сенсора** распакуйте архив, скопируйте папку `sensor` и создайте пользователя для сервиса:

```bash
unzip -o /tmp/egress-sentinel.zip -d /tmp/
cp -r /tmp/egress-sentinel/sensor /opt/egress-sentinel-sensor
useradd --system --home-dir /opt/egress-sentinel-sensor --no-create-home --shell /usr/sbin/nologin sentinel-sensor
cp /opt/egress-sentinel-sensor/config.example.json /opt/egress-sentinel-sensor/config.json
```

## Шаг 5. Заполните `config.json`

```bash
nano /opt/egress-sentinel-sensor/config.json
```

```json
{
  "reportUrl": "https://monitor.example.com/api/sensor/report",
  "token": "токен из шага 2",
  "xrayPath": "/usr/local/bin/xray",
  "intervalSeconds": 60,
  "nodes": [
    { "id": "ID узла NL-1 из панели", "link": "vless://…ссылка клиента sentinel-sensor на NL-1…" },
    { "id": "ID узла DE-1 из панели", "link": "vless://…", "expectIp": "203.0.113.20" }
  ]
}
```

Остальные поля можно не трогать:

| Поле | Что значит | По умолчанию |
|---|---|---|
| `reportUrl` | Адрес панели + `/api/sensor/report` | — |
| `token` | Токен сенсора из панели | — |
| `xrayPath` | Путь к Xray | `xray` |
| `intervalSeconds` | Как часто проверять, с (15–600) | `60` |
| `timeoutSeconds` | Сколько ждать ответа через туннель, с | `10` |
| `probeUrl` | Что открывать через туннель. Успех — ответ 2xx или 3xx | `https://www.gstatic.com/generate_204` |
| `ipUrl` | Сервис, который возвращает выходной IP. `""` — не проверять | `https://api.ipify.org` |
| `canaries` | Адреса для проверки прямого интернета у сенсора. Должны отвечать все. Оставьте хотя бы один зарубежный | `https://ya.ru`, `https://www.gstatic.com/generate_204` |
| `basePort` | Первый локальный порт Xray (по одному на узел) | `20800` |
| `nodes[].id` | ID узла из панели (Traffic sensors → Exit node IDs) | — |
| `nodes[].link` | Ссылка `vless://`. Пустая — узел пропускается | — |
| `nodes[].expectIp` | Необязательно: ожидаемый выходной IP. Если IP другой, это сбой | — |
| `nodes[].pinnedPeerCertSha256` | Только для `security=tls` с самоподписанным сертификатом (см. ниже) | — |

> Canaries по умолчанию рассчитаны на сенсор в России: `ya.ru` — местный адрес, gstatic — зарубежный. В другой стране замените `ya.ru` на надёжный сайт этой страны.

В файле лежат ключи доступа к вашим узлам. Закройте его от других пользователей:

```bash
chown -R sentinel-sensor:sentinel-sensor /opt/egress-sentinel-sensor
chmod 600 /opt/egress-sentinel-sensor/config.json
```

> **Самоподписанный сертификат (`security=tls`, в ссылке `allowInsecure=1`).** В Xray-core 26 параметр `allowInsecure` удалён: сертификат нужно «закрепить» по отпечатку. Узнайте его командой `xray tls ping <адрес узла>:<порт>` (строка `Cert's leaf SHA256`), затем добавьте узлу `"pinnedPeerCertSha256": "<SHA-256>"`. Для Reality и обычных сертификатов (Let's Encrypt и т.п.) это не нужно.

## Шаг 6. Проверьте вручную

```bash
sudo -u sentinel-sensor node /opt/egress-sentinel-sensor/sensor.js --check
```

Команда выполняет одну проверку и печатает результат. Отчёт мониторингу при этом **не** отправляется. Пример вывода:

```
The monitor accepted the token of sensor "MSK-1".
  b89fa31e → nl1.example.com:443 = "NL-1"
  f8b29bd6 → de1.example.com:443 = "DE-1"
✓ NL-1: 182 ms · exit IP 203.0.113.11
✗ DE-1: No response through the tunnel (timeout)
```

Если что-то не так:

| Сообщение | Что сделать |
|---|---|
| `the sensor token was rejected` | Проверьте `token`. Если сомневаетесь, выпустите новый в панели |
| `looks like a Cloudflare challenge` | Cloudflare блокирует запросы сенсора. В Cloudflare: Security → WAF → Custom rules → правило с действием **Skip** для условия *URI Path starts with* `/api/sensor/` |
| `⚠ no such exit node in the monitor` | `id` не совпадает с ID в панели |
| `Xray rejected the configuration: …` | Ошибка в параметрах ссылки. Сравните со ссылкой, которая работает в вашем клиенте |
| `nodes[0] (…): …` | Ссылку не удалось разобрать, в тексте ошибки сказано почему. Саму ссылку сенсор не выводит: в ней ключ |
| Все узлы `✗`, хотя в клиенте всё работает | Проверьте, что сервер сенсора вообще достаёт до узлов: `curl -v telnet://<узел>:<порт>` |

## Шаг 7. Запустите как сервис

```bash
cp /opt/egress-sentinel-sensor/egress-sentinel-sensor.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now egress-sentinel-sensor
journalctl -u egress-sentinel-sensor -f
```

Примерно через минуту администраторам придёт `📡 TRAFFIC SENSOR CONNECTED`. В панели статус сенсора станет **ONLINE**, а у узлов появится строка **Traffic (VLESS)**.

## Обслуживание

| Задача | Как |
|---|---|
| Журнал | `journalctl -u egress-sentinel-sensor -n 100` |
| Изменили `config.json` | `systemctl restart egress-sentinel-sensor` |
| Обновление сенсора | Скопируйте новые `sensor.js` и `vless.js`, затем `systemctl restart egress-sentinel-sensor`. `config.json` не перезаписывайте |
| Добавили узел в мониторинге | Добавьте его `id` и ссылку в `nodes`, затем перезапустите сенсор |
| Узел не нужно проверять (нет VLESS, например сервер раздачи конфигураций) | В панели: карточка узла → **Edit exit node** → выключите **Traffic verification (VLESS)**. Сенсор пропустит его со следующего цикла, перезапуск и правка `config.json` не нужны |
| Отключить сенсор | `systemctl disable --now egress-sentinel-sensor` и удалите его в панели (**Remove**) |

## Как мониторинг обрабатывает данные сенсора

- **Трафик не проходит.** Узел отвечает на прямую проверку, но сенсор сообщает, что трафик не проходит. Для мониторинга это сбой проверки, по одному на каждый отчёт сенсора. После `failThreshold` таких проверок подряд объявляется недоступность.
- **Несколько сенсоров.** Сбой засчитывается, только если трафик не проходит ни у одного из сенсоров, которые проверяют узел.
- **Сенсор молчит.** Если отчётов нет 3 интервала подряд (минимум 3 минуты), сенсор получает статус OFFLINE; если он присылает `sensorOk: false` — IMPAIRED. В обоих случаях его данные не учитываются, узлы проверяются только напрямую, а администраторы получают уведомление (категорию можно выключить в Notification settings). Тревога, поднятая по данным сенсора, не снимается до нового отчёта.
- **Что видит мониторинг.** Только «прошёл / не прошёл», задержку и выходной IP. Ссылки и ключи остаются на сервере сенсора.
- **Сети в России.** Некоторые российские сети «замораживают» соединения с Cloudflare после ~16 КБ, поэтому панель за Cloudflare оттуда может почти не открываться. Отчёты сенсора маленькие и проходят.
