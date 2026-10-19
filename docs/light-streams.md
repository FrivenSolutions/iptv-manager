# Light streams: server-side transcoding for multi-view

Some TVs can't decode several HD channels at once. A Chromecast with Google TV, for example,
manages about 134 frames of 1080p H.264 per second, so three 1080p60 channels (180) all stutter.
When TileIPTV sees that, it can switch a **side window** (never the one being heard) to a
**light** copy of the same channel from your playlist server: 720p, at most 30 fps, about
2.5 Mb/s. The light copy is roughly a quarter of the decoding work.

This needs two things from the playlist server.

## 1. Tell the app where the light copy is

Add a `tileiptv-light` attribute to each video channel's `#EXTINF` line, with an absolute URL:

```
#EXTINF:-1 tvg-id="…" tvg-name="Sports 1" group-title="Sports" tileiptv-light="http://server:8080/light/TOKEN/1234.ts",Sports 1
http://provider.example/live/…/1234.ts
```

- Other players ignore attributes they don't know.
- Leave it off radio and audio-only channels.
- Leave it off channels that are already light (720p or lower at 30 fps or less), or include it
  anyway; the app only uses it when a window is dropping frames.

### Xtream Codes logins (and other playlists without tags)

Xtream logins don't carry M3U attributes, so the app can't see `tileiptv-light` there. Instead the
playlist's **Light stream URL** setting in the app gives a rule, e.g. `{url}?light=1`, and the app
asks for the normal stream URL with that added:

```
http://server:8080/live/USER/PASS/1234.ts?light=1
```

The server must recognise it and answer with the light copy (stream it, or `302` redirect to the
channel's light URL). If it ignores the parameter and sends the original, the app notices (the
picture is taller than 720p), goes back to the original and doesn't ask again for that channel.

## 2. Serve the light copy

`GET /light/<token>/<channel id>.ts` (any path works; the app uses the URL as given):

- Protect it with the same token or auth as the playlist.
- Respond `200`, `Content-Type: video/mp2t`, and stream ffmpeg's output for as long as the client
  stays connected (chunked; no Content-Length).
- Start ffmpeg on request; **kill it as soon as the client disconnects**. Each light stream holds
  its own connection to the provider, so a leftover ffmpeg uses up provider connections.
- Cap concurrent transcodes (say 4). When full, answer `503`: the app keeps the original stream
  and shows its "too much for this TV" message instead.
- Send the first bytes quickly: the app gives up on a stream that sends nothing for about 10 s.

### ffmpeg on the N100 (Intel Quick Sync via VAAPI)

```
ffmpeg -hide_banner -loglevel warning \
  -reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 5 \
  -fflags +genpts+discardcorrupt \
  -hwaccel vaapi -hwaccel_device /dev/dri/renderD128 -hwaccel_output_format vaapi \
  -i "$SOURCE_URL" \
  -map 0:v:0 -map 0:a:0? \
  -vf "deinterlace_vaapi=rate=frame:auto=1,fps=fps='if(gt(source_fps,31),source_fps/2,source_fps)',scale_vaapi=w=-2:h='min(720,ih)'" \
  -c:v h264_vaapi -profile:v main -b:v 2500k -maxrate 3000k -bufsize 6000k -g 60 -bf 0 \
  -c:a copy \
  -f mpegts -flush_packets 1 pipe:1
```

What each part is for:

| Part | Why |
|---|---|
| `-reconnect …` | Ride out short provider hiccups instead of ending the stream. |
| `-hwaccel vaapi … -hwaccel_output_format vaapi` | Decode on the N100's GPU and keep frames there (low CPU). |
| `-map 0:v:0 -map 0:a:0?` | First video and first audio track (the `?` allows channels with no audio). |
| `deinterlace_vaapi=…auto=1` | Deinterlaces 1080i channels; progressive ones pass through untouched. |
| `fps=…source_fps/2…` | Halves 50/60 fps to 25/30; leaves 25/30 fps alone. Needs ffmpeg 5.0 or newer. |
| `scale_vaapi=…720…` | 720p (smaller sources keep their size). |
| `-c:v h264_vaapi … -bf 0` | Hardware H.264 encode with no B-frames, the easiest kind for TV decoders. |
| `-c:a copy` | Audio passed through unchanged: costs nothing, and side windows are muted anyway. |
| `-f mpegts -flush_packets 1 pipe:1` | MPEG-TS to stdout, sent as soon as it's ready. |

If the `fps` expression is rejected (older ffmpeg), use a fixed `fps=30` for 60 fps channels and
`fps=25` for 50 fps ones, or leave the frame rate alone (720p60 is still about half the work).

Without hardware encoding, swap the video part for software (about 1–2 CPU cores per stream):

```
-vf "yadif=mode=0:deint=interlaced,fps=…,scale=-2:'min(720,ih)'" -c:v libx264 -preset veryfast -tune zerolatency -b:v 2500k -maxrate 3000k -bufsize 6000k -g 60 -bf 0
```

### Docker

The container needs the GPU and an ffmpeg with VAAPI:

- `--device /dev/dri:/dev/dri` (and the container user in the `render`/`video` group).
- ffmpeg with VAAPI and the Intel media driver, e.g. `jellyfin-ffmpeg`, or Debian/Ubuntu `ffmpeg`
  plus `intel-media-va-driver-non-free`.
- Check with `vainfo`: it should list `VAProfileH264Main` with `VAEntrypointEncSlice`.

## Testing

```
curl -s -m 15 -o light.ts "http://server:8080/light/TOKEN/1234.ts"
ffprobe light.ts
```

Expect 1280×720 H.264, 25 or 30 fps, around 2.5 Mb/s. It should play in VLC, and ffmpeg should end
within a second or two of curl finishing. Run three at once and check the CPU stays low.

## What the app does with it

- Reads `tileiptv-light` from the playlist.
- In multi-view, when windows keep dropping frames, it switches side windows that have a light copy
  to it, then waits for things to settle. It shows the "too much for this TV" message only if
  that's still not enough, or if no light copy is available.
- Stream info shows **light (server)** for those windows.
- A window goes back to the original stream when it becomes the window being heard, changes
  channel, or when windows are closed and there's room again.
