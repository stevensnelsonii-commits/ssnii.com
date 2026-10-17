// Swamp Shell — mobile nav toggle. No dependencies.
(function () {
  var btn = document.querySelector(".nav-toggle");
  var links = document.getElementById("nav-links");
  if (!btn || !links) return;
  btn.addEventListener("click", function () {
    var open = links.classList.toggle("open");
    btn.setAttribute("aria-expanded", open ? "true" : "false");
  });
  links.addEventListener("click", function (e) {
    if (e.target.tagName === "A") {
      links.classList.remove("open");
      btn.setAttribute("aria-expanded", "false");
    }
  });
})();
