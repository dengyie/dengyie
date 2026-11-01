import urllib.request
import os

def fetch_svg(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    return urllib.request.urlopen(req, timeout=15).read().decode("utf-8")

def fetch_with_fallback(urls):
    """Try each URL in order; reject upstream error cards (HTTP 200 but broken SVG)."""
    last_err = None
    for url in urls:
        try:
            svg = fetch_svg(url)
            if "Something went wrong" in svg:
                raise ValueError("upstream returned an error card")
            return svg, url
        except Exception as e:
            print(f"source failed: {url} -> {e}")
            last_err = e
    raise last_err

def main():
    # Primary: self-hosted instance on Huawei Cloud SG (see hw-sg ops doc).
    # Fallbacks: public vercel instance (works intermittently, suffers
    # DEPLOYMENT_PAUSED) — a degraded but fresh card beats a frozen README.
    stats_sources = [
        "https://grs.mangoqwq.com/index?username=dengyie&show_icons=true&theme=tokyonight&count_private=true&hide_border=true",
        "https://github-readme-stats.vercel.app/api?username=dengyie&show_icons=true&theme=tokyonight&count_private=true&hide_border=true",
    ]
    streak_sources = [
        "https://streak-stats.demolab.com?user=dengyie&theme=tokyonight&hide_border=true",
        "https://streak-stats.demolab.com?user=dengyie&theme=tokyonight&hide_border=true",  # single official source; extend with a mirror here if it ever dies
    ]

    try:
        svg_stats, stats_src = fetch_with_fallback(stats_sources)
        svg_streak, streak_src = fetch_with_fallback(streak_sources)
        print(f"stats source: {stats_src}")
        print(f"streak source: {streak_src}")

        # Merge into a single horizontal composite SVG (height: 195)
        # Left card (stats): width 467
        # Right card (streak): width 495
        # Divider line: precisely matched to streak-stats native vertical line format
        #   stroke="#E4E2E2", stroke-width="1", y1="28", y2="170", vector-effect="non-scaling-stroke",
        #   stroke-linejoin="miter", stroke-linecap="square", stroke-miterlimit="3"
        combined_svg = f"""<svg width="982" height="195" viewBox="0 0 982 195" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect width="982" height="195" rx="4.5" fill="#1A1B27"/>
  <svg x="5" y="0" width="467" height="195">
    {svg_stats}
  </svg>
  <line x1="477" y1="28" x2="477" y2="170" vector-effect="non-scaling-stroke" stroke-width="1" stroke="#E4E2E2" stroke-linejoin="miter" stroke-linecap="square" stroke-miterlimit="3"/>
  <svg x="482" y="0" width="495" height="195">
    {svg_streak}
  </svg>
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
