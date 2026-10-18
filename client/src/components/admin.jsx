/**
 * Small building blocks shared by the admin screens.
 *
 * These exist because pagination and a search box were about to be written a
 * third and fourth time with slightly different markup, which is how two admin
 * pages end up disagreeing about what "page 2" means. They add NO new styling:
 * every class used here already exists in the stylesheet, so there is no second
 * visual language to keep in sync.
 */
import { cx } from "../utils/format";

/**
 * Page buttons for an offset-paginated list.
 *
 * The window is a fixed size around the current page rather than "all pages", so
 * a 40,000-row directory does not render 800 buttons. First/last are always
 * reachable, and the current page is announced rather than only coloured - colour
 * alone tells a screen-reader user nothing about where they are.
 */
export function Pagination({ page, pages, onChange, label = "Pagination" }) {
  if (pages <= 1) return null;

  const WINDOW = 2;
  const shown = [];
  for (let p = 1; p <= pages; p += 1) {
    const inWindow = p === 1 || p === pages || Math.abs(p - page) <= WINDOW;
    if (inWindow) shown.push(p);
  }
  // Collapse the gap left where the window skipped pages.
  const items = [];
  shown.forEach((p, i) => {
    if (i > 0 && p - shown[i - 1] > 1) items.push("gap");
    items.push(p);
  });

  return (
    <nav className="row row-wrap" style={{ gap: "0.25rem" }} aria-label={label}>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        onClick={() => onChange(page - 1)}
        disabled={page <= 1}
        aria-label="Previous page"
      >
        ‹
      </button>
      {items.map((it, i) =>
        it === "gap" ? (
          <span key={`gap${i}`} className="tiny muted" aria-hidden="true">
            …
          </span>
        ) : (
          <button
            key={it}
            type="button"
            className={cx("btn btn-sm", it === page ? "btn-primary" : "btn-ghost")}
            onClick={() => onChange(it)}
            aria-current={it === page ? "page" : undefined}
            aria-label={`Page ${it}${it === page ? ", current page" : ""}`}
          >
            {it}
          </button>
        ),
      )}
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        onClick={() => onChange(page + 1)}
        disabled={page >= pages}
        aria-label="Next page"
      >
        ›
      </button>
    </nav>
  );
}

/**
 * A labelled search box.
 *
 * A real `<label>` (visually hidden rather than absent) rather than a
 * placeholder: a placeholder disappears as soon as there is a value, which
 * leaves a screen-reader user with no idea what the field was for.
 */
export function SearchInput({
  value,
  onChange,
  placeholder = "Search",
  label = placeholder,
  width = 280,
}) {
  return (
    <div style={{ minWidth: 0, flex: `1 1 ${width}px` }}>
      <label className="sr-only" htmlFor={`search-${label}`}>
        {label}
      </label>
      <input
        id={`search-${label}`}
        type="search"
        className="input"
        style={{ width: "100%" }}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}