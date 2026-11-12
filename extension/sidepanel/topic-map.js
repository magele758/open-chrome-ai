// Keep the local map readable while retaining every neighbor in the index.
const NS = "http://www.w3.org/2000/svg";
function svg(tag, attrs) {
  const el = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
  return el;
}
function node(map, name, x, y, activate) {
  const group = svg("g", activate ? { role: "button", tabindex: 0, "aria-label": name } : {});
  const label = svg("text", { x, y: y + 5, "text-anchor": "middle" });
  label.textContent = name.length > 13 ? name.slice(0, 12) + "…" : name;
  const title = svg("title", {});
  title.textContent = name;
  group.append(title, svg("rect", { x: x - 85, y: y - 18, width: 170, height: 36, rx: 12 }), label);
  if (activate) {
    group.onclick = activate;
    group.onkeydown = event => {
      if (["Enter", " "].includes(event.key)) { event.preventDefault(); activate(); }
    };
  } else group.classList.add("focus-topic");
  map.append(group);
}

export function drawTopicMap(topic, related, jump) {
  const map = svg("svg", { viewBox: "0 0 660 270", role: "group", "aria-label": topic + "的关联图谱" });
  const neighbors = related.slice(0, 6);
  const points = neighbors.map((r, i) => {
    const angle = (2 * Math.PI * i) / neighbors.length;
    return { ...r, x: 330 + 235 * Math.cos(angle), y: 135 + 125 * Math.sin(angle) * .88 };
  });
  for (const { x, y, count } of points) {
    const edge = svg("line", { x1: 330, y1: 135, x2: x, y2: y, "stroke-width": Math.min(5, 1 + Math.log2(count)) });
    const title = svg("title", {});
    title.textContent = "共同剪藏 " + count + " 篇";
    edge.append(title); map.append(edge);
  }
  for (const point of points) node(map, point.topic, point.x, point.y, () => jump(point.topic));
  node(map, topic, 330, 135);
  return map;
}
