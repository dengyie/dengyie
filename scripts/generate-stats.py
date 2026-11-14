import time
import urllib.request
import os

STATS_ERROR_MARKS = ("Something went wrong",)
# "Error lable" is the (misspelled) comment the streak app puts in every error
# card — belt-and-braces alongside the human-readable strings, so a 200 error
# card is rejected even if its message text ever changes.
STREAK_ERROR_MARKS = (
    "Something went wrong",
    "Could not find a user with that name.",
    "Error lable",
)


def fetch_svg(url, timeout=30):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    return urllib.request.urlopen(req, timeout=timeout).read().decode("utf-8")


def fetch_with_fallback(urls, error_marks, attempts=2):
    """Try each URL in order (with retries per URL); reject upstream error
    cards (HTTP 200 but broken SVG). The public streak instance routinely
    exceeds 15 s reads (observed 2026-11-03), which killed the whole run when
    there was a single 15 s attempt — hence timeout=30 + 2 attempts."""
    last_err = None
    for url in urls:
        for attempt in range(1, attempts + 1):
            try:
                svg = fetch_svg(url)
                for mark in error_marks:
                    if mark in svg:
                        raise ValueError(f"upstream error card: {mark!r}")
                return svg, url
            except Exception as e:
                print(f"source failed (attempt {attempt}/{attempts}): {url} -> {e}")
                last_err = e
                if attempt < attempts:
                    time.sleep(3)
    raise last_err


def main():
    # Primary: self-hosted instance on Huawei Cloud SG (see hw-sg ops doc).
    #   &t=<epoch> busts BOTH cache layers (Cloudflare edge + shim memory cache)
    #   so the daily workflow always gets fresh upstream data.
    # Fallback: public vercel instance (works intermittently, suffers
    # DEPLOYMENT_PAUSED) — a degraded but fresh card beats a frozen README.
    # NOTE: count_private was dropped — it is a dead param upstream (replaced by
    # include_all_commits years ago) and the self-hosted shim's strict allowlist
    # rejects unknown params with 400.
    stats_sources = [
        "https://grs.mangoqwq.com/index?username=dengyie&show_icons=true&theme=tokyonight&include_all_commits=true&hide_border=true"
        f"&t={int(time.time())}",
        "https://github-readme-stats.vercel.app/api?username=dengyie&show_icons=true&theme=tokyonight&include_all_commits=true&hide_border=true",
    ]
    # Primary: self-hosted streak-stats on hw-sg (same origin as grs, Host-routed
    # via streak.mangoqwq.com; see infrastructure/streak/README.md). `t=` busts the
    # Cloudflare edge; the PHP app caches its GraphQL response for 10min.
    # Fallback: official public instance — recurrently 503 / very slow globally
    # (observed 2026-11-03/04), kept only as a degraded last resort.
    streak_sources = [
        "https://streak.mangoqwq.com?user=dengyie&theme=tokyonight&hide_border=true"
        f"&t={int(time.time())}",
        "https://streak-stats.demolab.com?user=dengyie&theme=tokyonight&hide_border=true",
    ]

    try:
        svg_stats, stats_src = fetch_with_fallback(stats_sources, STATS_ERROR_MARKS)
        svg_streak, streak_src = fetch_with_fallback(streak_sources, STREAK_ERROR_MARKS)
        print(f"stats source: {stats_src}")
        print(f"streak source: {streak_src}")

        # Merge into a single horizontal composite SVG (height: 195)
        # Left card (stats): width 467
        # Right card (streak): width 495
        # Divider line: precisely matched to streak-stats native vertical line format
        #   stroke="#E4E2E2", stroke-width="1", y1="28", y2="170", vector-effect="non-scaling-stroke",
        #   stroke-linejoin="miter", stroke-linecap="square", stroke-miterlimit="3"
        #
        # README polish layer (pure SMIL — GitHub sanitizes <script>, so no JS):
        #   1. Animated gradient border: rounded-rect stroke painted with a
        #      Tokyo-Night-accent linearGradient whose gradientTransform rotates
        #      continuously (SMIL animateTransform, 12s/turn). Degrades to a
        #      static accent border wherever SMIL is unsupported.
        #   2. Shimmer sweep: a low-opacity white diagonal band sliding across
        #      the card every 9s, clipped to the rounded card shape so it never
        #      bleeds outside the border.
        combined_svg = f"""<svg width="982" height="195" viewBox="0 0 982 195" fill="none" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="borderFlow" x1="0" y1="0" x2="982" y2="0" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#70a5fd"/>
      <stop offset="0.35" stop-color="#bb9af7"/>
      <stop offset="0.7" stop-color="#9ece6a"/>
      <stop offset="1" stop-color="#70a5fd"/>
      <animateTransform attributeName="gradientTransform" type="rotate" from="0 491 97.5" to="360 491 97.5" dur="12s" repeatCount="indefinite"/>
    </linearGradient>
    <linearGradient id="shimmerBand" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0"/>
      <stop offset="0.5" stop-color="#ffffff" stop-opacity="0.06"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
    <clipPath id="cardClip">
      <rect width="982" height="195" rx="4.5"/>
    </clipPath>
  </defs>
  <rect width="982" height="195" rx="4.5" fill="#1A1B27"/>
  <g clip-path="url(#cardClip)">
    <svg x="5" y="0" width="467" height="195">
      {svg_stats}
    </svg>
    <line x1="477" y1="28" x2="477" y2="170" vector-effect="non-scaling-stroke" stroke-width="1" stroke="#E4E2E2" stroke-linejoin="miter" stroke-linecap="square" stroke-miterlimit="3"/>
    <svg x="482" y="0" width="495" height="195">
      {svg_streak}
    </svg>
    <rect x="-140" y="-30" width="110" height="255" fill="url(#shimmerBand)" transform="skewX(-18)">
      <animate attributeName="x" values="-140;1032" dur="9s" begin="2s" repeatCount="indefinite"/>
    </rect>
  </g>
  <rect x="0.75" y="0.75" width="980.5" height="193.5" rx="4.5" fill="none" stroke="url(#borderFlow)" stroke-width="1.5" opacity="0.9"/>
</svg>"""

        os.makedirs("assets", exist_ok=True)
        with open("assets/github-stats.svg", "w", encoding="utf-8") as f:
            f.write(combined_svg)
        print("Successfully generated assets/github-stats.svg with identical divider style")
    except Exception as e:
        print(f"Error generating stats SVG: {e}")
        raise e


if __name__ == "__main__":
    main()
