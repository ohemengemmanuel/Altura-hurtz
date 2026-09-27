/* Renders the beat catalogue from data/beats.js with play buttons and buy links. */
(function () {
  const list = document.getElementById("beat-list");
  if (!list) return;

  const cfg = window.AH_CONFIG;
  const beats = window.AH_BEATS || [];
  const icon = (name) => '<span class="material-symbols-rounded" aria-hidden="true">' + name + "</span>";
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  if (!beats.length) {
    list.innerHTML =
      '<div class="empty-state">' + icon("library_music") +
      "<h3>New beats coming soon</h3>" +
      "<p>The catalogue is being loaded. In the meantime, request a custom beat below or message us for what is available now.</p>" +
      '<a class="btn btn-ghost" href="#" data-whatsapp-link target="_blank" rel="noopener">' + icon("chat") + "Ask on WhatsApp</a></div>";
    const wa = list.querySelector("[data-whatsapp-link]");
    if (cfg.contact.whatsapp) wa.href = "https://wa.me/" + cfg.contact.whatsapp;
    return;
  }

  const audio = new Audio();
  let playingBtn = null;

  list.innerHTML = beats.map((b, i) => {
    const msg = "Hi Altura Hertz, I want to buy the beat \"" + b.title + "\" (" + b.bpm + " BPM, " + b.key + ").";
    return '<article class="beat">' +
      '<button class="play" type="button" data-i="' + i + '" aria-label="Play preview of ' + esc(b.title) + '">' + icon("play_arrow") + "</button>" +
      '<div><div class="title">' + esc(b.title) + '</div><div class="meta">' + esc(b.genre) + " / " + esc(b.bpm) + " BPM / " + esc(b.key) + "</div></div>" +
      '<span class="beat-price">' + cfg.currency + Number(b.price).toLocaleString("en-GH") + "</span>" +
      '<a class="btn btn-primary" target="_blank" rel="noopener" href="https://wa.me/' + cfg.contact.whatsapp + "?text=" + encodeURIComponent(msg) + '">' + icon("shopping_cart") + "Buy</a>" +
      "</article>";
  }).join("");

  list.addEventListener("click", (e) => {
    const btn = e.target.closest(".play");
    if (!btn) return;
    const b = beats[Number(btn.dataset.i)];
    if (playingBtn === btn) {
      if (audio.paused) {
        audio.play();
        btn.querySelector(".material-symbols-rounded").textContent = "pause";
      } else {
        audio.pause();
      }
      return;
    }
    if (playingBtn) playingBtn.querySelector(".material-symbols-rounded").textContent = "play_arrow";
    audio.src = b.preview;
    audio.play();
    playingBtn = btn;
    btn.querySelector(".material-symbols-rounded").textContent = "pause";
  });
  audio.addEventListener("pause", () => { if (playingBtn) playingBtn.querySelector(".material-symbols-rounded").textContent = "play_arrow"; });
  audio.addEventListener("ended", () => { if (playingBtn) playingBtn.querySelector(".material-symbols-rounded").textContent = "play_arrow"; });
})();
