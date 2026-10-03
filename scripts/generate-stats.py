import urllib.request
import os

def fetch_svg(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    return urllib.request.urlopen(req, timeout=15).read().decode("utf-8")

def main():
    url_stats = "https://github-readme-stats.vercel.app/api?username=dengyie&show_icons=true&theme=tokyonight&count_private=true&hide_border=true"
    url_streak = "https://streak-stats.demolab.com?user=dengyie&theme=tokyonight&hide_border=true"

    try:
        svg_stats = fetch_svg(url_stats)
        svg_streak = fetch_svg(url_streak)

        # Total width: 467 (stats) + 20 (gap with divider) + 495 (streak) + 10 (padding) = 992
        # Divider line placed at x=482, extending vertically from y=25 to y=170
        combined_svg = f"""<svg width="985" height="195" viewBox="0 0 985 195" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect width="985" height="195" rx="8" fill="#1a1b27"/>
  <svg x="5" y="0" width="467" height="195">
    {svg_stats}
  </svg>
  <line x1="482" y1="25" x2="482" y2="170" stroke="#383e5a" stroke-width="1.5" stroke-linecap="round" />
  <svg x="490" y="0" width="495" height="195">
    {svg_streak}
  </svg>
</svg>"""

        os.makedirs("assets", exist_ok=True)
        with open("assets/github-stats.svg", "w", encoding="utf-8") as f:
            f.write(combined_svg)
        print("Successfully generated assets/github-stats.svg with divider line")
    except Exception as e:
        print(f"Error generating stats SVG: {e}")
        raise e

if __name__ == "__main__":
    main()
