# Установка Egress Sentinel

[English version](INSTALL.md)

Пошаговая инструкция для чистого VPS на **Debian 12** или **Ubuntu 22.04 / 24.04**. Займёт около 30 минут.

В итоге на сервере будут работать:

- **egress-sentinel** — сервис systemd. Проверяет выходные узлы, шлёт уведомления в Telegram и обслуживает панель (мини-приложение) на `127.0.0.1:8080`.
- **Caddy** (или уже установленный nginx) — принимает HTTPS на вашем домене и передаёт запросы боту.

```
Telegram ──HTTPS──▶ Caddy/nginx :443 ──▶ egress-sentinel 127.0.0.1:8080
                                     │
                                     └──▶ проверки выходных узлов (ping / TCP / HTTP)
```

> Мониторинг должен работать на **отдельном** сервере, а не на одном из выходных узлов. Иначе при падении этого узла сообщать о нём будет некому.

Во всех командах ниже замените:

| Пример | На что заменить |
|---|---|
| `203.0.113.10` | IP-адрес сервера мониторинга |
| `monitor.example.com` | домен или поддомен для панели |

---

## Что нужно заранее

- [ ] VPS с доступом по SSH под root или пользователем с `sudo`.
- [ ] Домен или поддомен, DNS которого вы можете редактировать.
- [ ] Аккаунт Telegram. Группа не нужна: тревоги получают одобренные вами пользователи в личные сообщения.

---

## Шаг 1. Создайте бота в Telegram

1. Откройте [@BotFather](https://t.me/BotFather) и отправьте `/newbot`. Придумайте имя и username бота.
2. Сохраните **токен** вида `123456789:AAH...`. Никому его не показывайте.
3. Откройте личный чат с новым ботом и нажмите **Start**. Без этого бот не сможет писать вам лично.
4. Необязательно: если хотите дублировать тревоги в группу, добавьте бота в неё.

## Шаг 2. Направьте домен на сервер

В панели управления DNS создайте запись:

| Тип | Имя | Значение |
|---|---|---|
| A | `monitor` (или `@` для корня домена) | `203.0.113.10` |

Проверьте, что запись появилась (может занять от минуты до часа). Команда должна вывести IP сервера:

```bash
nslookup monitor.example.com
```

## Шаг 3. Подготовьте сервер

Подключитесь к серверу:

```bash
ssh root@203.0.113.10
```

Установите системные пакеты и Node.js 22:

```bash
apt update && apt upgrade -y
apt install -y curl ca-certificates iputils-ping nano sudo unzip
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs
```

Проверьте версию: нужна **v20.12 или новее**.

```bash
node -v
```

Проверьте, что часы сервера синхронизированы: неверное время ломает проверку подписи мини-приложения. В строке `System clock synchronized` должно быть `yes`.

```bash
timedatectl
```

### Файрвол

Если вы пользуетесь `ufw`, откройте SSH, 80 и 443. Обязательно сначала SSH, иначе потеряете доступ к серверу:

```bash
ufw allow OpenSSH
ufw allow 80,443/tcp
ufw enable
```

Порт 8080 открывать **не нужно**: бот слушает только `127.0.0.1`. Если у хостинга есть собственный файрвол в панели управления, откройте 80 и 443 и там.

## Шаг 4. Скопируйте проект на сервер

**На своём компьютере** загрузите архив релиза:

```bash
scp egress-sentinel.zip root@203.0.113.10:/tmp/
```

Вернитесь в SSH-сессию. Распакуйте архив в `/opt`, создайте системного пользователя для сервиса и передайте ему файлы:

```bash
unzip /tmp/egress-sentinel.zip -d /opt/
useradd --system --home-dir /opt/egress-sentinel --no-create-home --shell /usr/sbin/nologin sentinel
chown -R sentinel:sentinel /opt/egress-sentinel
```

Должны быть видны `index.js`, `lib/`, `webapp/`, `deploy/`, `config.example.json`, `.env.example`:

```bash
ls -la /opt/egress-sentinel
```

## Шаг 5. Заполните `.env`

```bash
cd /opt/egress-sentinel
cp .env.example .env
nano .env
```

На этом этапе заполните так:

```ini
TELEGRAM_TOKEN=123456789:AAH...ваш-токен
ADMIN_IDS=
CHAT_IDS=
WEBAPP_URL=https://monitor.example.com
WEBAPP_PORT=8080
WEBAPP_SHORT_NAME=
DRY_RUN=0
```

`ADMIN_IDS` пока пустой: свой ID узнаете на шаге 7. `CHAT_IDS` оставьте пустым, если группа не нужна. Сохраните файл (`Ctrl+O`, `Enter`, `Ctrl+X`) и закройте доступ к нему для посторонних:

```bash
chown sentinel:sentinel .env
chmod 600 .env
```

## Шаг 6. Создайте `config.json`

```bash
cp config.example.json config.json
chown sentinel:sentinel config.json
nano config.json
```

| Параметр | Что поставить |
|---|---|
| `adminName` | Ваше имя для строки *Administrator* в уведомлениях |
| `monitorName` | Имя сервера мониторинга в строке *Issued by*, например `monitor-01` |
| `timezone` | Часовой пояс для времени в сообщениях, например `Europe/Moscow` |
| `intervalSeconds` | Как часто проверять узлы, по умолчанию 60 |
| `failThreshold` | Сколько сбоев подряд нужно для тревоги, по умолчанию 3 |
| `remindEveryMinutes` | Как часто повторять тревогу, если инцидент не подтверждён (0 — не повторять) |
| `latencyThresholdMs` | Порог задержки для ping и TCP, мс; выше него — уведомление `PERFORMANCE DEGRADATION`. Поставьте немного выше обычной задержки ваших узлов. Для отдельных узлов порог можно переопределить в панели |
| `latencyChecks` | Сколько медленных проверок подряд нужно для тревоги по задержке, по умолчанию 3 |
| `maintenanceNoticeMinutes` | За сколько минут до запланированного обслуживания напомнить подписчикам, по умолчанию 60 |

Список `servers` оставьте пустым `[]`: выходные узлы удобнее добавить через панель на шаге 12. Полный список параметров — в [README](../README.ru.md#настройки).

## Шаг 7. Узнайте свой Telegram ID

Запустите бота вручную **от пользователя `sentinel`**. Это важно: если запустить от root, бот создаст файлы, которые сервис потом не сможет изменять.

```bash
sudo -u sentinel node /opt/egress-sentinel/index.js
```

Предупреждение `ADMIN_IDS is not set — bootstrap mode` на этом этапе — нормально. Пока бот работает, напишите ему **в личку** `/myid`. Бот ответит `Your Telegram user ID: ...`.

Если хотите дублировать тревоги в группу, напишите там `/chatid` (или `/chatid@username_бота`). Бот ответит `Chat ID: -100...`.

Остановите бота: `Ctrl+C`. Впишите полученные значения в `.env`:

```bash
nano /opt/egress-sentinel/.env
```

```ini
ADMIN_IDS=123456789
CHAT_IDS=
```

Несколько администраторов или групп указываются через запятую без пробелов. Если группа не нужна, `CHAT_IDS` оставьте пустым.

## Шаг 8. Проверьте отправку сообщений

```bash
sudo -u sentinel node /opt/egress-sentinel/index.js --test
```

Вам в личку (и в группу, если она задана) должно прийти сообщение **🧪 TEST NOTIFICATION**. Бот после этого завершится сам.

Если сообщение не пришло, смотрите раздел [Решение проблем](#решение-проблем).

## Шаг 9. Запустите бота как сервис

```bash
which node
```

Если путь отличается от `/usr/bin/node`, исправьте `ExecStart` в `/opt/egress-sentinel/deploy/egress-sentinel.service`.

```bash
cp /opt/egress-sentinel/deploy/egress-sentinel.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now egress-sentinel
```

Проверьте, что сервис работает (`active (running)`):

```bash
systemctl status egress-sentinel
```

В журнале должны быть строки `Starting as @ваш_бот` и `Mini App: http://127.0.0.1:8080`:

```bash
journalctl -u egress-sentinel -n 30
```

Вам в личку придёт сообщение **ℹ️ MONITORING SERVICE STARTED**.

## Шаг 10. Включите HTTPS

Сначала проверьте, не занят ли порт 443 другим веб-сервером:

```bash
ss -ltnp | grep ':443 '
```

- Пусто или `caddy` — используйте **вариант А (Caddy)**.
- `nginx` — на сервере уже есть сайты. Используйте **вариант Б (nginx)**: Caddy не сможет занять порт 443 и не получит сертификат.

### Вариант А. Caddy (на сервере нет других сайтов)

Установите Caddy. В Debian 12 и Ubuntu 24.04 он есть в стандартных репозиториях:

```bash
apt install -y caddy
```

<details>
<summary>Если пакет <code>caddy</code> не найден (например, Ubuntu 22.04)</summary>

Подключите официальный репозиторий Caddy:

```bash
apt install -y debian-keyring debian-archive-keyring apt-transport-https gnupg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt update
apt install -y caddy
```

</details>

Скопируйте конфиг и впишите в него свой домен вместо `monitor.example.com`:

```bash
cp /opt/egress-sentinel/deploy/Caddyfile /etc/caddy/Caddyfile
nano /etc/caddy/Caddyfile
```

Примените:

```bash
systemctl reload caddy
```

Через 10–30 секунд Caddy получит сертификат. Команда должна вывести `HTTP/2 200`:

```bash
curl -sI https://monitor.example.com | head -1
```

### Вариант Б. nginx уже работает на сервере (например, сайты за Cloudflare)

Добавьте в nginx отдельный сайт, который передаёт запросы боту. Существующие сайты при этом не меняются.

```bash
cp /opt/egress-sentinel/deploy/nginx.conf /etc/nginx/sites-available/egress-sentinel
nano /etc/nginx/sites-available/egress-sentinel
```

Укажите `server_name` и пути к сертификату. Затем включите сайт, проверьте конфиг и перечитайте его. `reload` не прерывает работу других сайтов, а при ошибке в конфиге `nginx -t` её покажет, и ничего не применится:

```bash
ln -s /etc/nginx/sites-available/egress-sentinel /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
```

Если установлен Caddy, отключите его, чтобы он не пытался занять порты:

```bash
systemctl disable --now caddy
```

**Сертификат.** Либо Let's Encrypt (`apt install -y certbot python3-certbot-nginx`, затем `certbot --nginx -d monitor.example.com`), либо, если домен проксируется через Cloudflare, **сертификат Cloudflare Origin**. Origin-сертификат работает, только если запись проксируется. В панели Cloudflare:
- **DNS:** у записи включите оранжевое облако (*Proxied*);
- **SSL/TLS:** режим **Full (strict)**.

### Проверка (оба варианта)

Можно открыть `https://monitor.example.com` в обычном браузере. Страница напишет *«This application must be opened from Telegram»*, и это правильно: вне Telegram панель не работает.

## Шаг 11. Подключите мини-приложение в BotFather

**Кнопка Dashboard в личке с ботом** настраивается автоматически при запуске сервиса. Если её не видно, закройте и снова откройте чат с ботом. Без группы этого достаточно.

**Ссылка Open dashboard в группе** (только если используете группу). Чтобы она открывала панель, а не просто чат с ботом, включите основное мини-приложение бота:

1. В @BotFather отправьте `/mybots` и выберите своего бота.
2. **Bot Settings** → **Configure Mini App** → **Enable Mini App**.
3. Отправьте адрес `https://monitor.example.com`.

Названия пунктов в BotFather со временем меняются. Ищите раздел про *Mini App*.

Другой вариант — создать отдельное приложение командой `/newapp`, вписать его короткое имя в `.env` (`WEBAPP_SHORT_NAME=...`) и выполнить `systemctl restart egress-sentinel`.

## Шаг 12. Добавьте узлы и проверьте работу

1. Откройте личку с ботом и нажмите **Dashboard**. В правом верхнем углу должна быть роль **ADMINISTRATOR**.
2. Нажмите **+ Add exit node**. Укажите имя (например, `NL-1`), способ проверки и адрес.
   - **TCP port** — порт, на котором узел принимает подключения (например, 443). Самый надёжный вариант.
   - **ICMP ping** — если узел отвечает на ping.
   - **HTTP(S)** — если на узле есть веб-страница или health-check.
3. Нажмите **Test check**. Должно быть *Check passed*. Затем **Add exit node**.
4. Повторите для остальных узлов.
5. Включите себе уведомления: переключатель **Incident notifications** на главном экране панели или команда `/subscribe` в личке с ботом.
6. Напишите боту `/status`. Придёт отчёт с кнопками **Refresh** и **Open dashboard**.

### Как пользователи получают доступ

1. Пользователь находит бота (дайте ему ссылку `https://t.me/<username_бота>`) и нажимает **Start**.
2. Бот предлагает кнопку **🔐 Request access**. Пользователь нажимает её.
3. Вам приходит **ACCESS REQUEST** с кнопками **✅ Approve** и **⛔ Deny**.
4. После одобрения пользователь получает **ACCESS GRANTED**, автоматически подписывается на тревоги и может открыть панель с ролью **VIEWER** (адреса узлов скрыты).

Все пользователи и заявки видны в панели: **Administration → Users & access**. Там же можно отозвать доступ. Пользователь может сам отключить уведомления командой `/unsubscribe` или в панели.

### Финальная проверка

- [ ] Тестовое сообщение пришло вам в личку (шаг 8).
- [ ] `systemctl status egress-sentinel` показывает `active (running)`.
- [ ] `https://monitor.example.com` открывается с действительным сертификатом.
- [ ] Dashboard в личке открывается с ролью ADMINISTRATOR.
- [ ] Узлы добавлены, все показывают OPERATIONAL.
- [ ] Заявка от тестового пользователя приходит вам, после **Approve** он получает доступ.

Проверка тревоги без реального падения: добавьте временный узел с заведомо закрытым портом (например, `TCP 127.0.0.1:1`). Через `failThreshold` проверок всем подписчикам придёт тревога. У вас как у администратора под ней будут кнопки **Acknowledge** и **Maintenance 1 h**. Нажмите **Acknowledge**, затем удалите узел в панели.

## Шаг 13 (необязательно). Сенсор трафика VLESS

Мониторинг проверяет, что узел отвечает. Проходит ли через узел трафик, проверяет **сенсор** на отдельном сервере, лучше в регионе ваших пользователей. Установка описана в [SENSOR.ru.md](SENSOR.ru.md). Код сенсора на сервер мониторинга копировать не нужно.

Сервер мониторинга принимает отчёты сенсора по адресу `https://monitor.example.com/api/sensor/report`, за тем же Caddy или nginx. Дополнительная настройка не нужна. Если домен проксируется через Cloudflare и сенсор пишет *looks like a Cloudflare challenge*, создайте в Cloudflare правило WAF **Skip** для пути `/api/sensor/`.

---

## Обслуживание

### Журнал

```bash
journalctl -u egress-sentinel -f
```

```bash
journalctl -u caddy -n 50
```

### Перезапуск

Нужен после правки `.env` или `config.json`. Добавление и изменение узлов, текстов и настроек уведомлений и расписания обслуживания в панели перезапуска не требует. Перезапуск не теряет открытые инциденты: бот продолжит их с тем же ID и не пришлёт повторную тревогу.

```bash
systemctl restart egress-sentinel
```

### Обновление

Копируйте **только код**, чтобы не затереть `.env`, `config.json` и `data/`. Загрузите новый архив, распакуйте во временную папку и скопируйте код:

```bash
unzip -o /tmp/egress-sentinel.zip -d /tmp/
cp -r /tmp/egress-sentinel/index.js /tmp/egress-sentinel/package.json /tmp/egress-sentinel/lib /tmp/egress-sentinel/webapp /tmp/egress-sentinel/deploy /opt/egress-sentinel/
chown -R sentinel:sentinel /opt/egress-sentinel
systemctl restart egress-sentinel
```

Если в обновлении изменился файл сервиса или Caddyfile, повторите шаг 9 или 10 для этого файла.

### Резервная копия

Всё, что накапливает бот, лежит в `/opt/egress-sentinel/data/`:
- `store.json` — узлы, расписание обслуживания, пользователи, тексты и настройки уведомлений, сенсоры;
- `state.json` — открытые инциденты;
- `history.json` — история для графиков;
- `incidents.json` — журнал инцидентов.

Плюс ваши `.env` и `config.json`.

Ежедневная копия в `/root/egress-sentinel-backup`, хранится 14 дней:

```bash
mkdir -p /root/egress-sentinel-backup
crontab -e
```

Добавьте строку:

```cron
0 4 * * * tar czf /root/egress-sentinel-backup/sentinel-$(date +\%F).tgz -C /opt/egress-sentinel data .env config.json && find /root/egress-sentinel-backup -name '*.tgz' -mtime +14 -delete
```

Восстановление: остановите сервис, распакуйте архив в `/opt/egress-sentinel`, выполните `chown -R sentinel:sentinel /opt/egress-sentinel` и запустите сервис.

---

## Решение проблем

| Симптом | Причина и решение |
|---|---|
| `Error: no access to .../data` | Бота запускали от root. Выполните `chown -R sentinel:sentinel /opt/egress-sentinel` и перезапустите сервис. |
| `Error: .../config.json not found` | Создайте его: `cp config.example.json config.json` (шаг 6). |
| `Error: ping does not work on this machine` | Не установлен ping: `apt install -y iputils-ping`. |
| `cannot connect to Telegram — check TELEGRAM_TOKEN` | Опечатка в токене, или сервер не может достучаться до `api.telegram.org`. |
| `--test` не присылает сообщение, в журнале `403 Forbidden` | Вы не нажали **Start** в личке с ботом (шаг 1), либо в `ADMIN_IDS` не ваш ID (узнать: `/myid`). |
| `--test` не присылает сообщение, в журнале `400 chat not found` | Неверный ID в `ADMIN_IDS` или `CHAT_IDS`. Для группы узнайте ID заново командой `/chatid`. |
| В журнале `ADMIN_IDS is not set — bootstrap mode` | Впишите свой ID в `ADMIN_IDS` и перезапустите сервис. Без этого некому одобрять заявки и получать тревоги. |
| Заявки на доступ не приходят | Вы не нажимали **Start** в личке с ботом, или вашего ID нет в `ADMIN_IDS`. Заявки также видны в панели: **Administration → Users & access**. |
| В журнале `the group became a supergroup, new ID: ...` | Telegram сменил ID группы. Впишите новый ID в `CHAT_IDS` и перезапустите сервис. |
| Бот не отвечает на `/status` в группе | Напишите `/status@username_бота`. Проверьте, что ID группы есть в `CHAT_IDS`. |
| `curl` к домену не отвечает или ошибка сертификата | DNS ещё не обновился (шаг 2) или закрыты порты 80/443 (файрвол сервера или хостинга). Смотрите `journalctl -u caddy -n 50`. |
| `curl` возвращает `502` | Caddy работает, а бот нет: `systemctl status egress-sentinel`. |
| Панель пишет *Authentication failed* | Панель открыта не из Telegram, или `TELEGRAM_TOKEN` принадлежит другому боту, или неверное время на сервере (`timedatectl`). Закройте панель и откройте заново. |
| Панель пишет *Access required* | Пользователь ещё не получил доступ. Он может нажать **Request access** прямо в панели, а вы одобрите заявку. |
| Не работает HTTPS, в журнале Caddy `bind: address already in use` | Порт 443 занят другим веб-сервером (обычно nginx). Используйте вариант Б из шага 10. |
| Кнопки Acknowledge / Maintenance отвечают *restricted to the responsible administrator* | Вашего ID нет в `ADMIN_IDS` (узнать: `/myid`). После правки перезапустите сервис. |
| *Open dashboard* в группе открывает просто чат с ботом | Не включено мини-приложение в BotFather (шаг 11). |
| Нет кнопки Dashboard в личке | `WEBAPP_URL` пуст или не начинается с `https://`. Перезапустите сервис и заново откройте чат. |
| В журнале `The monitor itself has no connectivity` | У сервера мониторинга пропал интернет. Бот специально не шлёт тревоги, чтобы не было ложного «всё упало». |
| Постоянные `PERFORMANCE DEGRADATION` по одному узлу | Его обычная задержка выше общего порога. Задайте узлу свой порог: **Edit exit node → Latency threshold**. |
| На графике разрыв | В это время бот не работал или у сервера не было интернета. Данных за этот период нет, в доступности он не учитывается. |
| Из российских сетей панель за Cloudflare грузится очень медленно или не грузится | Некоторые российские сети «замораживают» соединения с Cloudflare после ~16 КБ. Отчёты сенсора маленькие и проходят. Для самой панели пользователям таких сетей может понадобиться VPN, либо панель можно отдавать без проксирования Cloudflare. |

## Безопасность

- `.env` содержит токен бота: права `600`, владелец `sentinel`. Если токен утёк, перевыпустите его в BotFather (`/revoke`) и обновите `.env`.
- Бот слушает только `127.0.0.1:8080`, снаружи доступен только через Caddy или nginx по HTTPS.
- Каждый запрос панели подписан Telegram и проверяется токеном бота. Смотреть панель и получать тревоги могут только одобренные вами пользователи; управлять узлами и доступом — только пользователи из `ADMIN_IDS`.
- Сенсоры трафика авторизуются своими токенами. Мониторинг хранит только хеши токенов, а сенсор может только присылать отчёты и читать ID и имена узлов.
- В режиме отладки `--dry-run` проверка участников группы отключена, поэтому на сервере (где задан `WEBAPP_URL`) бот в этом режиме панель не запускает вообще. Не запускайте `--dry-run` параллельно с работающим сервисом: оба процесса пишут в одну папку `data/`.
