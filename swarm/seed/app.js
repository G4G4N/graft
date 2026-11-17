// Field Guide — a tiny hash-routed web app built by many agents at once.
import * as home from "./pages/home.js";
// imports:start (one import per page, keep sorted)
// imports:end

const routes = {
  "/": home,
  // routes:start (one route per page, keep sorted by path)
  // routes:end
};

function render() {
  const path = location.hash.slice(1) || "/";
  const page = routes[path] || home;
  document.getElementById("view").innerHTML = `<section class="page">${page.render(routes)}</section>`;
  document.title = `${page.title} · Field Guide`;
  for (const a of document.querySelectorAll("#nav a")) a.classList.toggle("active", a.getAttribute("href") === "#" + path);
}

addEventListener("hashchange", render);
render();
