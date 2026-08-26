// A small "type or click to pick a person" dropdown for the name/email fields.
//
// attachPeoplePicker(input, { people, onPick, preferGroup })
//   Wraps `input` so that focusing or typing in it shows a list of people from
//   site/people.js (the IIS people page) filtered by name or email. Picking one calls
//   onPick(person); the caller fills whatever fields it wants. Typing a name that is
//   not on the list still works — the picker never blocks free text.
//   preferGroup: a group name (e.g. "Professors") to list first when nothing is typed.

const MAX_ROWS = 40;

function matches(p, q) {
  return p.name.toLowerCase().includes(q) || p.email.toLowerCase().includes(q);
}

export function attachPeoplePicker(input, { people, onPick, preferGroup } = {}) {
  const wrap = document.createElement("div");
  wrap.className = "picker";
  input.parentNode.insertBefore(wrap, input);
  wrap.appendChild(input);
  input.setAttribute("autocomplete", "off");
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-expanded", "false");
  input.setAttribute("aria-autocomplete", "list");

  const list = document.createElement("ul");
  list.className = "picker-list";
  list.setAttribute("role", "listbox");
  list.hidden = true;
  wrap.appendChild(list);

  let rows = [];   // the <li>s currently shown, in order
  let active = -1;

  function ordered() {
    if (!preferGroup) return people;
    return [...people.filter((p) => p.group === preferGroup), ...people.filter((p) => p.group !== preferGroup)];
  }

  function close() {
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
    rows = [];
    active = -1;
  }

  function setActive(i) {
    if (active >= 0) rows[active].classList.remove("active");
    active = i;
    if (active >= 0) {
      rows[active].classList.add("active");
      rows[active].scrollIntoView({ block: "nearest" });
    }
  }

  function pick(p) {
    input.value = p.name;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    if (onPick) onPick(p);
    close();
  }

  function open() {
    const q = input.value.trim().toLowerCase();
    const found = ordered().filter((p) => !q || matches(p, q));
    list.innerHTML = "";
    rows = [];
    active = -1;
    if (!found.length) {
      const li = document.createElement("li");
      li.className = "picker-empty";
      li.textContent = "No match on the IIS people list — just type the name and email.";
      list.appendChild(li);
    }
    let lastGroup = null;
    for (const p of found.slice(0, MAX_ROWS)) {
      if (p.group !== lastGroup) {
        const h = document.createElement("li");
        h.className = "picker-group";
        h.textContent = p.group;
        list.appendChild(h);
        lastGroup = p.group;
      }
      const li = document.createElement("li");
      li.setAttribute("role", "option");
      li.innerHTML = `<span class="picker-name"></span><span class="picker-email"></span>`;
      li.querySelector(".picker-name").textContent = p.name;
      li.querySelector(".picker-email").textContent = p.email;
      // mousedown, not click: the input's blur would close the list before a click lands.
      li.addEventListener("mousedown", (e) => { e.preventDefault(); pick(p); });
      list.appendChild(li);
      rows.push(li);
    }
    if (found.length > MAX_ROWS) {
      const li = document.createElement("li");
      li.className = "picker-empty";
      li.textContent = `${found.length - MAX_ROWS} more — keep typing to narrow down.`;
      list.appendChild(li);
    }
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
  }

  input.addEventListener("focus", open);
  input.addEventListener("click", open);
  input.addEventListener("input", open);
  input.addEventListener("blur", close);
  input.addEventListener("keydown", (e) => {
    if (list.hidden) {
      if (e.key === "ArrowDown") { open(); e.preventDefault(); }
      return;
    }
    if (e.key === "ArrowDown") { setActive(Math.min(active + 1, rows.length - 1)); e.preventDefault(); }
    else if (e.key === "ArrowUp") { setActive(Math.max(active - 1, -1)); e.preventDefault(); }
    else if (e.key === "Enter" && active >= 0) { rows[active].dispatchEvent(new Event("mousedown")); e.preventDefault(); }
    else if (e.key === "Escape") { close(); }
    else if (e.key === "Tab") { close(); }
  });
}
