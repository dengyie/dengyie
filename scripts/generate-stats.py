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
