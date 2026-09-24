# IPTV Manager

A small, self-hosted IPTV playlist manager for a homelab. It pulls your provider's playlist and
guide, and you choose which categories and channels to keep with a few rules. It then publishes
trimmed **M3U**, **XMLTV** and **Xtream Codes** feeds for your IPTV apps (Jellyfin, TiviMate, VLC
and others). Refreshes run on a schedule, and new provider categories that match your rules
are added automatically.

It is a lighter alternative to tools like IPTV Boss or Dispatcharr: one Node.js process with an
embedded SQLite database and a single small dependency. It uses about 60 MB of RAM when idle. A
refresh of a large provider (20k channels and a 260 MB guide) peaks at about 300 MB and takes
around 25 seconds.

> **Note:** IPTV Manager does not provide any channels, streams or guide data. It only reorganizes
> playlists and guides from services you already have access to, such as your own IPTV
> subscription or an HDHomeRun tuner. Use it only with content you are entitled to.

## Features

- **Sources**
  - M3U playlists, by URL or uploaded file.
  - Xtream Codes accounts (host, username and password).
  - HDHomeRun network tuners: channels come from the box, and the guide comes from SiliconDust.
  - XMLTV guides, plain or gzip, several per source.
- **Automatic guide association:** each source uses its own guide:
  - An Xtream Codes source uses its `xmltv.php`.
  - An M3U source uses the `url-tvg` from its header.
  - An HDHomeRun source uses SiliconDust's guide service.

  Channels are matched to the guide by `tvg-id`, then by a normalized name (country prefixes and
  HD/FHD/4K tags are ignored). You can override the match per channel.
- **Filtering per output**
  - Category rules: *contains*, *does not contain*, *starts with*, *does not start with*,
    *ends with*, *does not end with*, *equals*, *does not equal* and *regex*.
  - Channel rules inside a category, with a live "matches N of M" count as you type.
  - Manual picks for categories and channels, including Select all and Deselect all.
  - A live preview of what the rules do before you save.
- **Multiple outputs:** each output is its own lineup with its own URLs and optional Xtream Codes
  login. One output can merge categories from several sources.
- **Stream delivery per output:** Direct, Redirect or Proxy (see [Stream modes](#stream-modes)).
- **Scheduled refresh** per source, every 12 hours by default. An empty or failed refresh never
  wipes working data.
- **Edits that survive refreshes:** channel name, logo, number and guide id; category display
  names; **Jellyfin categories** (Movies, Sports, News, Kids) per channel group.
- **Backup and restore** of all settings as one JSON file.
- Admin login for the web UI. Output URLs carry a random token, which you can regenerate.

Only live TV is supported. VOD and series are skipped on purpose.

## Install

### Docker Compose

```bash
git clone https://github.com/frittsasaurus/iptv-manager.git
cd iptv-manager
docker compose up -d --build
```

Open `http://<host>:8080` and choose an admin password.

Data (the database and uploads) lives in the `iptv-data` Docker volume; back that volume up. The
optional environment variables are `IPTV_PORT` (the host port, default 8080), `TZ` and
`ADMIN_PASSWORD`.

Without Compose:

```bash
docker build -t iptv-manager https://github.com/frittsasaurus/iptv-manager.git
docker run -d --name iptv-manager --restart unless-stopped -p 8080:8080 -v iptv-data:/data iptv-manager
```

The container runs as user 1000. If you bind-mount a host folder instead of a volume, run
`chown 1000:1000` on it first.

### Portainer

Portainer can build and run this repository straight from GitHub. This works with a standalone
Docker environment, not Swarm.

1. **Stacks → Add stack.** Name it `iptv-manager` and choose **Repository**.
2. Fill in the repository settings:
   - **Repository URL:** `https://github.com/frittsasaurus/iptv-manager`
   - **Repository reference:** `refs/heads/main`
   - **Compose path:** `docker-compose.yml`
3. Leave **Authentication** off; the repository is public.
4. Optional: turn on **GitOps updates** (polling) so Portainer rebuilds automatically when the
   repository changes. For this, enable **Force redeployment**.
5. Optional: under **Environment variables**, set `IPTV_PORT` or `ADMIN_PASSWORD`.
6. Click **Deploy the stack**, then open `http://<docker-host>:8080`.

To update manually, open the stack and click **Pull and redeploy**. Your data stays in the
`iptv-manager_iptv-data` volume.

### Proxmox

**Option A – dedicated LXC (recommended).** Run this on the Proxmox host as root. Nothing needs to
be installed on the host first, not even git:

```bash
bash -c "$(wget -qO- https://raw.githubusercontent.com/frittsasaurus/iptv-manager/main/proxmox/create-lxc.sh)"
```

The script creates an unprivileged Debian container (1 core, 512 MB RAM, 4 GB disk), installs
Node.js 24 and git inside it, and runs the app as a systemd service. It prints the URL when done.
You can put settings in front of the command, for example a fixed container ID and address, and
nightly updates turned on:

```bash
CTID=120 IP=192.168.1.50/24 GW=192.168.1.1 AUTO_UPDATE=1 bash -c "$(wget -qO- https://raw.githubusercontent.com/frittsasaurus/iptv-manager/main/proxmox/create-lxc.sh)"
```

The same script also works from a clone of the repository (`bash proxmox/create-lxc.sh`). Running it
again while an IPTV Manager container exists does nothing; it prints the update command instead.
Use `create-lxc.sh new` only if you really want a second container.

**Option B – an existing Debian/Ubuntu LXC or VM.** Inside it, as root:

```bash
bash -c "$(wget -qO- https://raw.githubusercontent.com/frittsasaurus/iptv-manager/main/proxmox/install.sh)"
```

#### Updating a Proxmox install

The app lives in `/opt/iptv-manager` as a git checkout, and it updates itself. From the Proxmox
host:

```bash
pct exec <container id> -- iptv-manager-update
```

Or run `iptv-manager-update` in the container's own console. It fetches the latest version and
stops if there is nothing new. It reinstalls dependencies only if they changed, then restarts the
service; it never runs apt or touches the container itself. If the new version does not start
within about 30 seconds, the previous one is restored automatically. That release is then skipped
until you run `iptv-manager-update --force`.

| Command (inside the container, or via `pct exec <id> --`) | What it does |
|---|---|
| `iptv-manager-update` | Update now |
| `iptv-manager-update --check` | Only show whether an update is available |
| `iptv-manager-update --status` | Installed version and nightly-update state |
| `iptv-manager-update --enable-auto [HH:MM]` | Update every night (default 04:00, plus up to 30 min random delay) |
| `iptv-manager-update --disable-auto` | Turn nightly updates off |
| `iptv-manager-update --force` | Reinstall and restart, or retry a skipped release |

Nightly updates are off unless you turn them on. They install whatever is on the `main` branch.
Forks can point an install at their own repository with `IPTV_REPO=<url>` (and `IPTV_BRANCH`).

Installs made before the updater existed need a one-time conversion. Run this on the host;
settings and data are kept:

```bash
bash -c "$(wget -qO- https://raw.githubusercontent.com/frittsasaurus/iptv-manager/main/proxmox/create-lxc.sh)" _ upgrade <container id>
```

**Option C – Docker.** Use the Docker instructions inside any VM or LXC that runs Docker.

The service runs as user `iptvm` with its data in `/var/lib/iptv-manager`. To follow the logs,
run `journalctl -u iptv-manager -f`.

### Updating

| Install | Update with |
|---|---|
| Docker Compose | `git pull && docker compose up -d --build` |
| Portainer | **Pull and redeploy** on the stack, or GitOps updates |
| Proxmox LXC or VM (options A and B) | `iptv-manager-update` inside it, `pct exec <id> -- iptv-manager-update` from the host, or nightly (see above) |

Database changes are applied automatically on start, and your settings are kept. Export a backup
first (**Settings → Backup & restore**) if you want a restore point.

## Using it

1. **Sources → Add source.** Paste an M3U URL, enter your Xtream Codes login, or choose
   HDHomeRun and enter the box's IP address. The first refresh starts immediately.
2. **Outputs → New output.** Add rules, for example:
   - Include categories that *start with* `US|`
   - Exclude categories that *contain* `adult`

   The category list shows what each rule does before you save. Click **Include** or
   **Exclude** on a category to override the rules for it. Expand a category (▸) to filter or
   pick its channels.
3. Copy the URLs from **Connect your apps** into your player:
   - **M3U:** `http://<host>:8080/o/<token>/playlist.m3u`
   - **EPG:** `http://<host>:8080/o/<token>/epg.xml` (or `epg.xml.gz`)
   - **Xtream Codes:** the server is `http://<host>:8080`, with the username and password
     shown on the output. Enable this under the output's Settings.

### How filtering decides

For each category in an output:

1. A manual **Include** or **Exclude** always wins.
2. If any **Exclude** rule matches, the category is out.
3. If the source has **Include** rules, the category must match at least one of them.
4. If no Include rules apply, the output's *include all* setting decides. It is off by
   default, so the category stays out.

Rules match the provider's original category name and are case-insensitive. Rules are
re-applied on every refresh. A category the provider adds later that matches your rules
appears in the output automatically, and it is flagged **new** in the UI for a week.

### Channel rules inside a category

Expand a category in an output (▸) to filter its channels by name. Channel rules work like
category rules: a channel is kept when it matches any **Include** rule and no **Exclude**
rule. For example, *Exclude channels whose name contains `backup`*. Channels the provider adds
later are sorted by these rules automatically.

Each rule shows how many channels its text matches ("matches 3 of 12") as you type. Tick or
untick a channel to pick it by hand; a hand pick beats the rules. **Select all** and
**Deselect all** pick every channel in the category at once. **Reset to rules** clears the
hand picks.

Channel rules and picks only apply once the category itself is in the output. If it is not,
the channel list still opens but is locked, with an **Include category** button. An excluded
category excludes all of its channels. Earlier hand picks are kept and apply again when you
include it.

### HDHomeRun tuners

Choose **HDHomeRun** when adding a source and enter the box's IP address. Give the box a DHCP
reservation so the address doesn't change. `hdhomerun.local` usually does not resolve from inside
Docker.

- **Channels** come from the box's own `lineup.json`, so run a channel scan on the box first.
  Channels are named with their tuner number first, such as `9.1 KUSA`, and the tuner number is
  also the channel number and guide id. Copy-protected (DRM) channels go into their own
  **HDHomeRun (DRM)** group so they are easy to exclude.
- **Guide:** the box reports a `DeviceAuth` key, which is used to fetch listings from SiliconDust's
  guide service. The full XMLTV feed (`api.hdhomerun.com/api/xmltv`) is tried first; it may require
  an HDHomeRun DVR subscription. If it is refused, the free JSON guide that the HDHomeRun apps use
  is paged through and converted to XMLTV instead. The source page shows which feed was used.
  Genre tags from the guide become XMLTV categories, and **Movies** is also tagged **Movie** for
  Jellyfin.
- **Streams** play straight from the box (`http://<box>:5004/auto/v9.1`), so use Direct or
  Redirect mode unless you need Proxy. Each stream uses one of the box's tuners.

### Jellyfin categories

Jellyfin sorts guide programmes into **Movies**, **Sports**, **News** and **Kids** using the
XMLTV `<category>` of each programme. You can tag a whole channel group so Jellyfin sorts it
correctly. Click **Edit group** on a source's category, or ✎ on a category row in an output. Then
tick one or more of Movies, Sports, News or Kids.

Every programme on every channel in that group gets the matching `<category>` in the published
guide. Categories the provider already set are kept, and a category is never added twice. The tag
belongs to the group, so it applies in every output that includes it and survives refreshes. The
values match Jellyfin's default category lists (`movie`, `sports`, `news`, `kids`). If you have
customized those lists in Jellyfin's XMLTV settings, keep these words in them.

Only channels with guide data are affected. A channel with no programmes has nothing to tag.

To use an output in Jellyfin, go to **Dashboard → Live TV**. Add an **M3U Tuner** with the
output's playlist URL and an **XMLTV** guide provider with its `epg.xml` URL.

### Backup and restore

Go to **Settings → Backup & restore**. **Export settings** downloads one JSON file with:
- sources, outputs and rules (category and channel)
- hand picks, channel and category edits, and Jellyfin tags
- each output's URL token and Xtream Codes login

It can include provider passwords (tick the box). The file then contains credentials, so
keep it safe.

**Import** replaces every source and output with the file's contents, then refreshes the
sources. Outputs keep their URLs, so your apps keep working. Playlists, guides and uploaded
files are not in the export; they are downloaded again.

### Stream modes

| Mode | Playlist URL points to | Bandwidth through this server | Provider credentials visible to clients |
|---|---|---|---|
| Direct | the provider | none | yes |
| Redirect | this server (302 to the provider) | none | only to the player, on redirect |
| Proxy | this server | all video | no |

Xtream Codes clients always build URLs on this server, so Direct behaves like Redirect for them.
Proxy mode does not enforce your provider's connection limit.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |
| `DATA_DIR` | `./data` (`/data` in Docker) | Database, uploads, cache |
| `ADMIN_PASSWORD` | (unset) | If set, it becomes the admin password on every start. Use it for recovery. |

If players reach the server by a different name than your browser does (a reverse proxy or DNS
name, for example), set **Settings → Base URL** so the published links use that address.

## Security

IPTV Manager is built for a home network.

- **Keep it on your LAN.** To reach it from outside, put it behind a VPN or a reverse proxy with
  HTTPS. Don't forward port 8080 straight to the internet.
- **Output URLs and Xtream Codes logins are passwords.** Anyone with an output's URL can watch that
  lineup. In Direct mode, the playlist also contains your provider's own stream URLs, which often
  embed your provider credentials. If a URL leaks, use **Regenerate URLs** on the output. That
  replaces the URL token only, so also change the output's Xtream Codes password if it has one.
- **The admin UI** needs a password (at least 8 characters). Changing it signs out every other
  session. If you forget it, start the app once with `ADMIN_PASSWORD` set.
- **Settings exports** can contain provider passwords, if you tick that option. Store them like
  any other credential.

To report a security problem, please open a GitHub issue without exploit details, or contact
the maintainer privately first.

## Development

```bash
git clone https://github.com/frittsasaurus/iptv-manager.git
cd iptv-manager
npm install
npm test                          # unit + end-to-end tests (fake provider included)
node scripts/demo-provider.js     # fake provider on :9090 (M3U, XMLTV and XC login demo/demo)
DATA_DIR=./data-dev node src/server.js
```

Requires Node.js 24 or newer, for the built-in `node:sqlite`. The only runtime dependency is
[`sax`](https://github.com/isaacs/sax-js). The web UI is plain JavaScript with no build step.

The layout of `src/`:

| File | Role |
|---|---|
| `server.js`, `app.js`, `http.js` | Entry point, routing, published outputs |
| `api.js`, `auth.js` | Admin REST API and login |
| `ingest.js`, `m3u.js`, `xmltv.js`, `hdhomerun.js` | Fetching and parsing sources and guides |
| `epgmatch.js`, `filters.js` | Guide matching, category/channel rules |
| `outputs/` | M3U, XMLTV and Xtream Codes output |
| `stream.js` | Redirect and proxy streaming |
| `backup.js`, `db.js`, `jobs.js` | Settings export/import, schema, refresh scheduler |

Issues and pull requests are welcome. Please run `npm test` before opening a pull request, and add
a test for any behavior you change.

## Credits

The HDHomeRun guide support follows the approach of
[HDHomeRunEPG-to-XmlTv](https://github.com/IncubusVictim/HDHomeRunEPG-to-XmlTv), reimplemented here
so no extra script or container is needed.

## License

Copyright (C) 2026 frittsasaurus

This program is free software: you can redistribute it and/or modify it under the terms of the
GNU General Public License as published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version. See [LICENSE](LICENSE) for the full text.

This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without
even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
