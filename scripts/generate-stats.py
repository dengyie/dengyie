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

        # Merge into a single perfectly balanced 2-column horizontal SVG (height: 195)
        # Stats width: ~470, Streak width: ~495, Total width: ~975
        combined_svg = f"""<svg width="975" height="195" viewBox="0 0 975 195" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect width="975" height="195" rx="8" fill="#1a1b27"/>
  <svg x="5" y="0" width="470" height="195">
    {svg_stats}
  </svg>
  <svg x="480" y="0" width="495" height="195">
    {svg_streak}
  </svg>
</svg>"""

        os.makedirs("assets", exist_ok=True)
        with open("assets/github-stats.svg", "w", encoding="utf-8") as f:
            f.write(combined_svg)
        print("Successfully generated 2-in-1 assets/github-stats.svg")
    except Exception as e:
        print(f"Error generating stats SVG: {e}")
        raise e

if __name__ == "__main__":
    main()
