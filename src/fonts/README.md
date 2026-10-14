# Portal fonts

The portal uses the website's Hanken Grotesk and Space Mono typefaces, served locally. Vite includes these WOFF2 files in the build with content-hashed names. No external font service or Content Security Policy exception is needed.

- `hanken-grotesk-latin.woff2`: Hanken Grotesk, normal, variable weights 400–800, Latin subset. [Google Fonts source](https://fonts.gstatic.com/s/hankengrotesk/v12/ieVn2YZDLWuGJpnzaiwFXS9tYtpd59A.woff2).
- `space-mono-latin.woff2`: Space Mono, normal, weight 400, Latin subset. [Google Fonts source](https://fonts.gstatic.com/s/spacemono/v17/i7dPIFZifjKcF5UAWdDRYEF8RQ.woff2).

Both fonts use the SIL Open Font License. The complete notices are in `public/fonts/Hanken-Grotesk-OFL.txt` and `public/fonts/Space-Mono-OFL.txt`; those notices are also included in every Hosting build. System fonts cover characters outside these subsets.
