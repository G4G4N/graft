export const title = "Home";

export function render(routes) {
  const pages = Object.entries(routes).filter(([path]) => path !== "/");
  return `
    <h1>Field Guide</h1>
    <p class="lede">A small guide to the natural world, written page by page by a team of agents.</p>
    <ul class="cards">
      ${pages.map(([path, p]) => `<li><a href="#${path}"><strong>${p.title}</strong><span>${p.summary ?? ""}</span></a></li>`).join("")}
    </ul>`;
}
