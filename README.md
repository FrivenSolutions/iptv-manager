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
  - Per-category toggles that hide empty sports/event placeholder channels, by name or by what
    the guide says is on now, using patterns you can edit.
  - A live preview of what the rules do before you save.
  - One search box for categories and channels: find a channel anywhere in an output and see
    whether it is in, and why.
- **Multiple outputs:** each output is its own lineup with its own URLs and optional Xtream Codes
  login. One output can merge categories from several sources.
- **Stream delivery per output:** Direct, Redirect or Proxy (see [Stream modes](#stream-modes)).
  In Proxy mode, viewers of the same channel share one connection, and each source is held to its
  provider's connection limit.
- **Scheduled refresh** per source, every 12 hours by default. An empty or failed refresh never
  wipes working data.
- **Edits that survive refreshes:** channel name, logo, number and guide id; category display
  names; **Jellyfin categories** (Movies, Sports, News, Kids) per channel group.
- **Backup and restore** of all settings as one JSON file, plus an automatic backup every day.
- **Alerts** by ntfy or webhook when a source keeps failing, an account is about to expire, or a
  guide has run out.
- **Movies and series** (optional) through an output's Xtream Codes login, picked with the same
  kind of rules on their own tabs.
- **Advanced options** (hidden until you turn them on): guide logos for channels without one, and
  name cleanup rules per output.
- Admin login for the web UI. Output URLs carry a random token, which you can regenerate.

Live TV comes first. **Movies and series** are optional, per source and per output (see
[Movies and series](#movies-and-series)); until you turn them on, they are skipped.

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

Or run `iptv-manager-update` in the container's own console. If `pct exec` answers
`Failed to exec "iptv-manager-update"`, use the full path once:
`pct exec <container id> -- /usr/local/bin/iptv-manager-update`. This affects installs converted
before the command was also linked into `/usr/bin`, and that first run adds the link. It fetches the latest version and
stops if there is nothing new. It reinstalls dependencies only if they changed, then restarts the
service; it never runs apt or touches the container itself. If the new version does not start
within about 30 seconds, the previous one is restored automatically. That release is then skipped
until you run `iptv-manager-update --force`.

**From the web interface.** When an update is available, **Settings → Version & updates** shows
an **Update now** button. The app runs as an unprivileged user and cannot update itself. The button
drops a request file in the app's data folder, and a systemd path unit that belongs to the updater
runs `iptv-manager-update` as root. That is the same update, health check and rollback as running it
by hand. The page shows the updater's progress, waits out the restart, and reloads into the new
version. If the button's place shows a `--setup` command instead, the path unit isn't installed
yet. Run `pct exec <container id> -- iptv-manager-update --setup` once; the updater also installs it
by itself on its next run.

| Command (inside the container, or via `pct exec <id> --`) | What it does |
|---|---|
| `iptv-manager-update` | Update now |
| `iptv-manager-update --check` | Only show whether an update is available |
| `iptv-manager-update --status` | Installed version and nightly-update state |
| `iptv-manager-update --enable-auto [HH:MM]` | Update every night (default 04:00, plus up to 30 min random delay) |
| `iptv-manager-update --disable-auto` | Turn nightly updates off |
| `iptv-manager-update --force` | Reinstall and restart, or retry a skipped release |
| `iptv-manager-update --setup` | Install or repair the systemd units, including the one behind **Update now** |

Nightly updates are off unless you turn them on, here or with the switch under **Settings →
Version & updates**. They install whatever is on the `main` branch.
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

**Knowing when to update.** **Settings → Version & updates** shows the running version (the git
commit). Once a day the app asks GitHub whether `main` has anything newer. When it does, an
**Update available** badge appears in the top bar, and the card lists the new changes with the
update steps for your install type. The check only reports; it never changes anything. You can
run it with **Check now**, turn the daily check off with the switch on that card, or point it at a
fork with the `IPTV_UPDATE_REPO=owner/name` environment variable. Docker images record their commit
when they are built, from the `.git` folder in the build context. An image built without it shows
"commit unknown" and can't be compared.

## Using it

1. **Sources → Add source.** Paste an M3U URL, enter your Xtream Codes login, or choose
   HDHomeRun and enter the box's IP address. The first refresh starts immediately.
2. **Outputs → New output.** Add rules, for example:
   - Include categories that *start with* `US|`
   - Exclude categories that *contain* `adult`

   The category list shows what each rule does before you save. Click **Include** or
   **Exclude** on a category to override the rules for it. Expand a category (▸) to filter or
   pick its channels. To find a channel, type part of its name in the search box: categories
   that hold a match show it as a chip, marked ✓ (in the output) or ✕ (with the reason). Click a
   chip to open its category at that channel.

   **Manage output** (at the bottom of **Connect your apps**) has, in order:
   - **Open playlist** and **Open guide**, to see what the output publishes.
   - **Refresh sources**, which reloads every source the output uses. **Duplicate** makes a copy
     with the same sources, rules, hand picks and settings, and its own URLs. The copy's Xtream
     Codes login starts off, because a username belongs to one output, so give it a new one.
   - **Pause output**, which switches off its URLs and every login until you **Resume** it, with
     nothing deleted; **Regenerate URLs**; and **Delete output**.
3. Copy the URLs from **Connect your apps** into your player:
   - **M3U:** `http://<host>:8080/o/<token>/playlist.m3u`
   - **EPG:** `http://<host>:8080/o/<token>/epg.xml` (or `epg.xml.gz`)
   - **Xtream Codes:** the server is `http://<host>:8080`, with the username and password
     shown on the output. Enable this under the output's Settings.

   **Sharing an output.** Under **Connect your apps → Other logins**, **+ Add login** gives
   someone their own username and password for the same output. Each login has its own playlist
   and guide URLs, and shows when it was last used. You can switch one off, or **Remove** it, and
   every other login keeps working. The output's token URLs are shared by everyone who has them,
   so give people a login rather than those.

### How filtering decides

For each category in an output:

1. A manual **Include** or **Exclude** always wins.
2. If any **Exclude** rule matches, the category is out.
3. If the source has **Include** rules, the category must match at least one of them.
4. If no Include rules apply, the output's *include all* setting decides. It is off by
   default, so the category stays out.

Rules are shown in an **Include** box and an **Exclude** box. You can arrange them by dragging
the ⠿ handle, or with the ↑/↓ buttons. To turn an include rule into an exclude rule or back, drag
it into the other box or press ⇄. Channel rules work the same way. The order within a box is only
for your own organization: any matching include counts, and an exclude match always wins.

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

### Hiding empty event channels

Event providers keep placeholder channels that only carry something when an event is scheduled.
They have names like `ESPN+ 03:`, `NFL 07 -`, `PPV 12` or `NBA 04 NO EVENT`, and gain a title such
as `ESPN+ 03: Lakers vs Celtics` once an event is on. In an output, expand an event category and
tick **Hide empty event channels** to drop the placeholders. The panel shows how many channels
currently look empty. The toggle is per category, because the same patterns would also hide
ordinary channels like "ESPN 2" elsewhere. A channel you pick by hand is always kept.

A channel counts as empty when its provider name matches any pattern in **Settings → Empty event
channels**. The patterns are case-insensitive regular expressions. The defaults cover names that
end with `:`, `-`, a number or `NO EVENT`. You can add patterns, remove them, or restore the
defaults, and a test box shows what a given name counts as. "Ends with a number" also hides a live
event whose title ends in a number (`PPV 01: UFC 300`). If that matters, replace it with
`^[^:]*\d\s*$`, which only counts names without a `:` as empty.

Names only change when the source refreshes, so give event sources a short refresh interval (for
example 1 hour) in the source's **Advanced** settings.

**By guide.** Some event channels keep a normal name, and their guide says "No Game Today" or "Off
Air" while nothing is on. The second toggle in the same place, **Hide channels by guide**, hides a
channel while the title of the programme airing now matches a pattern in **Settings → Guide
placeholders**. The defaults are *contains "no game today"* and *starts with "no event"*, *"no live
event"* or *"off air"*. The channel reappears by itself when a real listing starts; no refresh is
needed, because the output is re-evaluated at least once a minute. A few things to know:
- Players only see the change when they reload the playlist (TiviMate on start or its update
  interval, Jellyfin on its guide/tuner refresh).
- A channel with no listing airing now is not hidden, unless you tick the sub-option **Also hide
  channels with nothing listed right now**. That option is for providers whose event channels have
  an empty guide until a game is scheduled. It hides channels that have a guide id but nothing (or
  a blank title) airing now. Channels without any guide id are never hidden this way. As a safety
  net, if a source's guide has nothing airing now on any channel (it ran out or failed to refresh),
  nothing is hidden as "nothing listed" for that source.
- The expanded category shows what is on now for every channel, even with the toggle off, so you
  can judge the effect first.

The two toggles are independent, and hand picks win over both.

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
  Redirect mode unless you need Proxy. Each stream uses one of the box's tuners. In Proxy mode, the
  tuner count is the source's stream limit, and viewers of the same channel share a tuner.

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

**Automatic backups** are on by default. Once a day a full export (including provider passwords,
like the database next to it) is saved to `backups/` in the data folder, and the last 14 are
kept. The same card lists them with **Download** and **Restore**, and has **Back up now** and an
on/off switch. They sit on the same disk as the database, so copy one elsewhere now and then.

### Alerts

**Settings → Alerts** sends a notification to [ntfy](https://ntfy.sh) (a topic URL such as
`https://ntfy.sh/my-iptv`) or to any webhook (a JSON POST) when:
- a source has failed three refreshes in a row,
- an Xtream Codes account expires in 14, 7, 3 or 1 days, or has expired,
- a source's guide has run out (it has programmes, but none airing now).

Each problem is sent once, and a "Resolved" note follows when it clears (expiry warnings just move
on to the next step). The same list shows on the dashboard. Use **Send test** to check the address.

### Advanced options

Turn on **Settings → Show advanced options** to see features most setups don't need. Turning it
off hides them again; anything already set up keeps working.

- **Use guide logos for channels without one.** If the provider gives a channel no logo, the logo
  its guide lists is used. Provider logos and your own always win.
- **Name cleanup** (on each output's page). Find/replace rules on channel names, category names
  or both, such as `US: CNN ᴴᴰ` into `CNN`. Patterns are case-sensitive regular expressions, and
  `$1` works in the replacement. Rules run top to bottom, then leftover spaces are tidied.
  **Country prefix** and **Quality tags** presets are included, and a preview shows how many names
  change, with examples. Names you set by hand are never changed, and a name that would end up
  empty keeps its original. The cleaned names are used in the M3U, the XMLTV guide and the Xtream
  Codes login alike. On an output with movies and series, each rule also says where it applies:
  **Live TV**, **Movies & series** (titles and their categories) or **Everywhere**. Rules made
  before that apply to live TV. With advanced options off, an output with rules shows one line
  saying so.

### Movies and series

Off by default, in two places:

1. **The source.** Edit it and set **Content** to *Live TV, movies and series* (Xtream Codes and
   M3U sources). An Xtream Codes account's movie and series lists load on their own schedule,
   once a day by default (**Advanced → Refresh movies & series every**), and on every manual
   **Refresh**. The lists are read one entry at a time, so big catalogs don't need much memory.
   An M3U playlist's `/movie/` and `/series/` entries come with each refresh; episodes are
   grouped into shows by names like `Show S01 E02`.
2. **The output.** Tick **Include movies & series** under Settings. **Live TV**, **Movies** and
   **Series** tabs then appear on the output's page. Each VOD tab has its own rules and category
   list, which work like live TV's: include and exclude rules on category names, hand picks that
   always win, new categories that match added automatically, and an "include all of a source's
   categories when it has no Include rules" switch of its own. Expand a category (▸) to see its
   titles: untick the ones you don't want, or use **Select all**, **Deselect all** and **Reset
   to rules** for the whole category. ✎ renames a title (in every output). The search box finds
   titles as well as categories: matches show as chips under their category, ✓ in or ✕ out, and a
   click opens the category filtered to them.

Players get movies and series through the output's **Xtream Codes login** (TiviMate, IPTV
Smarters, Kodi and similar), with posters, plots and ratings passed on from the provider. A
movie's details and a show's episode list are fetched from the provider when a player opens
them. The M3U playlist and the XMLTV guide stay live TV only.

Playback follows the output's stream mode. Direct and Redirect send the player to the provider.
Proxy relays the video, seeking included, and counts each title that is playing against the
source's **Streams at once** limit.

### Stream modes

| Mode | Playlist URL points to | Bandwidth through this server | Provider credentials visible to clients |
|---|---|---|---|
| Direct | the provider | none | yes |
| Redirect | this server (302 to the provider) | none | only to the player, on redirect |
| Proxy | this server | all video | no |

Xtream Codes clients always build URLs on this server, so Direct behaves like Redirect for them.

**Connection limits (Proxy only).** Everyone watching the same channel shares one connection to
the provider, which opens with the first viewer and closes with the last. Each source can be held
to a number of channels playing at once: the source's **Advanced → Streams at once**. Blank means
automatic: the Xtream Codes account's `max_connections`, or the HDHomeRun's tuner count. 0 means
no limit. A new channel over the limit is refused with *503 Service Unavailable* instead of
knocking another stream off at the provider. More viewers of a channel already playing are
always let in. HLS channels count while their playlist or segments are being fetched, and for 30
seconds after. The Sources list shows the streams in use. Direct and Redirect can't be limited,
because players connect to the provider themselves.

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
  To share an output, give each person their own login (**Other logins**), so you can remove one
  without changing anything for anyone else.
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
