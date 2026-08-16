"""Fast rich entries for YouTube Music song search URLs.

Upstream `YoutubeMusicSearchURLIE` deliberately returns only `id` and `title`
for each song shelf renderer.  yt-dlp then downloads every video's webpage and
player response to recover artist, album, duration and thumbnail, which takes
roughly 1.5-7 seconds per track.  A 20-track search therefore sits behind a
30+ second loading state and can hit the request timeout before any result.

All of those facts are already present in the song shelf renderer, so this
plugin returns them as a flat `_type: url` entry.  ClassApp always searches
with `--flat-playlist`; when someone invokes yt-dlp without it, the entry is
still followed normally and upstream extraction is preserved.
"""

from __future__ import annotations

from yt_dlp.extractor.youtube._search import YoutubeMusicSearchURLIE
from yt_dlp.utils import parse_duration, traverse_obj


def _album_from_secondary_runs(runs: list[dict]) -> str | None:
    for run in runs:
        browse_id = traverse_obj(
            run, ("navigationEndpoint", "browseEndpoint", "browseId"))
        if not isinstance(browse_id, str) or not browse_id.startswith("MPRE"):
            continue
        text = traverse_obj(run, ("text",))
        if isinstance(text, str) and text:
            return text
    return None


class ClassappMusicSearchURLIE(YoutubeMusicSearchURLIE, plugin_name="classapp-music-search"):
    def _music_reponsive_list_entry(self, renderer):
        video_id = traverse_obj(renderer, ("playlistItemData", "videoId"))
        if not video_id:
            video_id = traverse_obj(
                renderer,
                (
                    "overlay",
                    "musicItemThumbnailOverlayRenderer",
                    "content",
                    "musicPlayButtonRenderer",
                    "playNavigationEndpoint",
                    "watchEndpoint",
                    "videoId",
                ),
            )
        if not video_id:
            return super()._music_reponsive_list_entry(renderer)

        title = traverse_obj(
            renderer,
            (
                "flexColumns",
                0,
                "musicResponsiveListItemFlexColumnRenderer",
                "text",
                "runs",
                0,
                "text",
            ),
        )
        if not isinstance(title, str) or not title:
            return super()._music_reponsive_list_entry(renderer)

        secondary_runs = traverse_obj(
            renderer,
            (
                "flexColumns",
                1,
                "musicResponsiveListItemFlexColumnRenderer",
                "text",
                "runs",
            ),
        )
        runs = secondary_runs if isinstance(secondary_runs, list) else []
        texts = [
            run.get("text")
            for run in runs
            if isinstance(run, dict) and isinstance(run.get("text"), str)
        ]
        artist = texts[0] if texts else None
        album = _album_from_secondary_runs(runs)
        duration = parse_duration(texts[-1]) if texts else None
        if duration is None:
            duration = parse_duration(
                traverse_obj(
                    renderer,
                    (
                        "flexColumns",
                        1,
                        "musicResponsiveListItemFlexColumnRenderer",
                        "text",
                        "accessibility",
                        "accessibilityData",
                        "label",
                    ),
                ),
            )
        thumbnail = traverse_obj(
            renderer,
            (
                "thumbnail",
                "musicThumbnailRenderer",
                "thumbnail",
                "thumbnails",
                -1,
                "url",
            ),
        )

        return {
            "_type": "url",
            "ie_key": "Youtube",
            "id": video_id,
            "url": f"https://music.youtube.com/watch?v={video_id}",
            "title": title,
            "artists": [artist] if artist else [],
            "album": album,
            "duration": duration if duration is not None else 0,
            "thumbnail": thumbnail if isinstance(thumbnail, str) else None,
        }


__all__ = ["ClassappMusicSearchURLIE"]
