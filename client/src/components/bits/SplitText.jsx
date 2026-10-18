import { useEffect, useRef, useState } from "react";

/* React-Bits style split reveal, dependency-free.
   Splits into chars/words and staggers them in with IntersectionObserver. */
export default function SplitText({
  text = "",
  as: Tag = "span",
  mode = "chars",
  delay = 0,
  stagger = 18,
  className = "",
  style,
}) {
  const ref = useRef(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) {
          setVisible(true);
          io.disconnect();
        }
      },
      { threshold: 0.2 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const parts = mode === "words" ? text.split(/(\s+)/) : [...text];

  return (
    <Tag ref={ref} className={`rb-split ${visible ? "is-in" : ""} ${className}`} style={style}>
      {parts.map((p, i) =>
        p.trim() === "" ? (
          <span key={i}>{p}</span>
        ) : (
          <span
            key={i}
            className="rb-split-part"
            style={{ transitionDelay: `${delay + i * stagger}ms` }}
          >
            {p}
          </span>
        ),
      )}
    </Tag>
  );
}
