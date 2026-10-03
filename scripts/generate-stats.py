import urllib.request
import os

def fetch_svg(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    return urllib.request.urlopen(req, timeout=15).read().decode("utf-8")

def main():
    url_stats = "https://github-readme-stats.vercel.app/api?username=dengyie&show_icons=true&theme=tokyonight&count_private=true&hide_border=true"
    url_langs = "https://github-readme-stats.vercel.app/api/top-langs/?username=dengyie&layout=compact&theme=tokyonight&hide_border=true"
    url_streak = "https://streak-stats.demolab.com?user=dengyie&theme=tokyonight&hide_border=true"

    try:
        svg_stats = fetch_svg(url_stats)
        svg_langs = fetch_svg(url_langs)
        svg_streak = fetch_svg(url_streak)

        # Merge into a single balanced SVG: 2-column top, 1-column bottom centered
        combined_svg = f"""<svg width="800" height="360" viewBox="0 0 800 360" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect width="800" height="360" rx="8" fill="#1a1b27"/>
  <svg x="10" y="0" width="460" height="195">
    {svg_stats}
  </svg>
  <svg x="475" y="0" width="315" height="195">
    {svg_langs}
  </svg>
  <svg x="152" y="195" width="495" height="165">
    {svg_streak}
  </svg>
</svg>"""

        os.makedirs("assets", exist_ok=True)
        with open("assets/github-stats.svg", "w", encoding="utf-8") as f:
            f.write(combined_svg)
        print("Successfully generated assets/github-stats.svg")
    except Exception as e:
        print(f"Error generating stats SVG: {e}")
        raise e

if __name__ == "__main__":
    main()
