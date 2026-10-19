// A floating "back to top" button for the scrolling content area: placed inside the scroll container, it appears once
// the page is scrolled down a screen or so and scrolls back up when clicked.
import { useEffect, useRef, useState } from "react";
import { t } from "../lib/i18n";

const SHOW_AFTER = 400; // px scrolled

export default function BackToTop() {
  const ref = useRef<HTMLButtonElement>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const scroller = ref.current?.parentElement;
    if (!scroller) return;
    const update = () => setShown(scroller.scrollTop > SHOW_AFTER);
    update();
    scroller.addEventListener("scroll", update, { passive: true });
    return () => scroller.removeEventListener("scroll", update);
  }, []);

  function toTop() {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    ref.current?.parentElement?.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
  }

  return (
    <button
      ref={ref}
      type="button"
      className={`back-to-top${shown ? " shown" : ""}`}
      onClick={toTop}
      aria-label={t("Back to top")}
      title={t("Back to top")}
      tabIndex={shown ? 0 : -1}
      aria-hidden={!shown}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M12 19V5M5 12l7-7 7 7" />
      </svg>
    </button>
  );
}
