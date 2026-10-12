export function portalWelcome() {
  return `<section class="panel portal-welcome" aria-labelledby="portal-welcome-title">
    <p class="eyebrow">WELCOME TO THE WORKSHOP</p>
    <h2 id="portal-welcome-title">Your camera. Your possibilities.</h2>
    <p class="welcome-intro">Welcome to Camera Hacks. Your portal is ready—here’s where you’ll find the files, ideas, and community to make your camera your own.</p>
    <div class="welcome-grid">
      <div><span class="welcome-number" aria-hidden="true">01 /</span><h3>Start with your files.</h3><p>Find the latest firmware, camera software, 3D files, and guides below. Check compatibility and agree to the Software &amp; Design Usage License before downloading.</p></div>
      <div><span class="welcome-number" aria-hidden="true">02 /</span><h3>Make it your own.</h3><p>Explore customer-made designs and code modifications, or share a build of your own.</p><a href="#community">Explore Community Builds <span aria-hidden="true">↗</span></a></div>
      <div><span class="welcome-number" aria-hidden="true">03 /</span><h3>Help shape what’s next.</h3><p>Suggest improvements, like other customers’ ideas, and follow development updates.</p><a href="#enhancements">Visit Enhancement Requests <span aria-hidden="true">↗</span></a></div>
    </div>
    <div class="welcome-footer"><p>Happy building,<br><strong>Malcolm</strong></p><button id="dismiss-welcome" class="button">Got it—explore downloads <span aria-hidden="true">↓</span></button></div>
  </section>`;
}
