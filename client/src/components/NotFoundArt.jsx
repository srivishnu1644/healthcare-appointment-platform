import { useId } from "react";

/**
 * NotFoundArt — the illustration for the not-found page.
 *
 * WHY INLINE SVG AND NOT A STOCK PHOTO
 * ------------------------------------
 * A photograph here would be an extra network request that could itself fail —
 * on the one page whose entire job is to explain a failure — and it would land
 * unstyled against a soft glass/blue surface. An inline SVG inherits
 * `currentColor` and the `--brand-*` tokens, so it is always in the palette,
 * scales to any DPI, costs about two kilobytes and cannot 404.
 *
 * It also gets to carry the actual metaphor: a dashed ghost slot with nothing
 * booked in it, and the appointment card lifted out of it and drifting away.
 * A random stock photo cannot say anything about this product.
 *
 * Colours are brand tokens rather than literals so the artwork follows the
 * theme instead of drifting from it the next time a hue is adjusted.
 */
export default function NotFoundArt({ className }) {
  // Gradient ids must be unique: the component is rendered into isolation in
  // the checks harness as well as in the app, and duplicate ids in one document
  // make the first definition win everywhere.
  const uid = useId().replace(/:/g, "");
  const card = `nf-card-${uid}`;
  const glow = `nf-glow-${uid}`;
  const shade = `nf-shade-${uid}`;
  const title = `nf-title-${uid}`;
  const desc = `nf-desc-${uid}`;

  return (
    <svg
      className={className}
      viewBox="0 0 360 260"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-labelledby={`${title} ${desc}`}
    >
      <title id={title}>An appointment card lifted out of an empty slot</title>
      <desc id={desc}>
        A dashed outline marks a slot on the schedule with nothing booked in it,
        while an appointment card floats away from it.
      </desc>

      <defs>
        {/* The card's brand fill, echoing the primary button's gradient. */}
        <linearGradient id={card} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="var(--brand-500)" />
          <stop offset="55%" stopColor="var(--brand-600)" />
          <stop offset="100%" stopColor="var(--brand-900)" />
        </linearGradient>

        {/* Soft aurora behind everything, matching the landing page's glow. */}
        <radialGradient id={glow} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--brand-100)" stopOpacity="0.9" />
          <stop offset="60%" stopColor="var(--brand-50)" stopOpacity="0.45" />
          <stop offset="100%" stopColor="var(--brand-50)" stopOpacity="0" />
        </radialGradient>

        {/* Contact shadow. A gradient ellipse rather than a blur filter:
           filters are the most expensive thing on a page that should load
           instantly, and a soft ellipse reads the same at this size. */}
        <radialGradient id={shade} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--brand-900)" stopOpacity="0.22" />
          <stop offset="100%" stopColor="var(--brand-900)" stopOpacity="0" />
        </radialGradient>
      </defs>

      <circle cx="172" cy="118" r="112" fill={`url(#${glow})`} />

      <ellipse cx="196" cy="222" rx="112" ry="13" fill={`url(#${shade})`} />

      {/* The slot: present, empty, and outlined rather than filled — the page
          that is not here, drawn as the space where it should have been. */}
      <g transform="rotate(-5 132 150)">
        <rect
          x="52"
          y="98"
          width="164"
          height="108"
          rx="18"
          fill="var(--brand-50)"
          fillOpacity="0.5"
          stroke="var(--brand-200)"
          strokeWidth="2"
          strokeDasharray="9 8"
        />
        <circle cx="96" cy="140" r="13" fill="var(--brand-200)" fillOpacity="0.55" />
        <rect x="120" y="132" width="62" height="8" rx="4" fill="var(--brand-200)" fillOpacity="0.5" />
        <rect x="74" y="166" width="118" height="7" rx="3.5" fill="var(--brand-200)" fillOpacity="0.38" />
      </g>

      {/* Trailing dashes: the direction of travel, drawn as motion rather than
          implied by the offset alone. */}
      <g stroke="var(--brand-200)" strokeWidth="4" strokeLinecap="round" opacity="0.85">
        <line x1="104" y1="196" x2="126" y2="188" />
        <line x1="122" y1="212" x2="146" y2="203" />
      </g>

      {/* The appointment card, out of its slot. */}
      <g transform="rotate(6 232 118)">
        <rect x="142" y="46" width="172" height="142" rx="20" fill={`url(#${card})`} />
        {/* Top edge highlight, the trick that makes a flat fill read as glass. */}
        <rect x="142" y="46" width="172" height="52" rx="20" fill="#fff" opacity="0.12" />

        <circle cx="178" cy="86" r="19" fill="#fff" opacity="0.28" />
        <circle cx="178" cy="81" r="6.5" fill="#fff" opacity="0.9" />
        <path
          d="M165 99c3.2-6.6 7.8-9.9 13-9.9s9.8 3.3 13 9.9"
          fill="#fff"
          opacity="0.9"
        />

        <rect x="205" y="74" width="78" height="11" rx="5.5" fill="#fff" opacity="0.92" />
        <rect x="205" y="91" width="52" height="8" rx="4" fill="#fff" opacity="0.55" />

        <rect x="162" y="118" width="132" height="1.5" fill="#fff" opacity="0.28" />

        <circle cx="172" cy="140" r="5" fill="#fff" opacity="0.55" />
        <rect x="184" y="136" width="70" height="8" rx="4" fill="#fff" opacity="0.45" />

        <circle cx="172" cy="163" r="5" fill="#fff" opacity="0.55" />
        <rect x="184" y="159" width="46" height="8" rx="4" fill="#fff" opacity="0.45" />

        {/* Status pill — the sort of chip the real cards carry. */}
        <rect x="232" y="155" width="62" height="21" rx="10.5" fill="#fff" opacity="0.92" />
      </g>
    </svg>
  );
}
