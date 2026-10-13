import { useEffect, useId, useRef, useState } from "react";
import type { ProfileRange } from "../lib/types";

interface RangeOption {
  value: ProfileRange;
  label: string;
}

/** List-dense timeframe options in UI order (mirrors PROFILE_RANGES). */
const OPTIONS: ReadonlyArray<RangeOption> = [
  { value: "today", label: "Today" },
  { value: "week", label: "Week" },
  { value: "fourWeeks", label: "4 weeks" },
  { value: "sixMonths", label: "6 months" },
  { value: "year2026", label: "2026" },
  { value: "lifetime", label: "Lifetime" },
];

function labelFor(value: ProfileRange): string {
  const hit = OPTIONS.find((o) => o.value === value);
  return hit ? hit.label : "4 weeks";
}

function indexFor(value: ProfileRange): number {
  const i = OPTIONS.findIndex((o) => o.value === value);
  return i >= 0 ? i : 2;
}

interface Props {
  value: ProfileRange;
  onChange: (r: ProfileRange) => void;
  /** Id of the visible Timeframe label in the pane. */
  labelId: string;
}

/**
 * Listbox timeframe menu (Arena Arm A, list-dense).
 * Button owns aria-haspopup=listbox; the list owns role=listbox with six
 * options. Keyboard: Enter/Space/ArrowDown/ArrowUp opens, Arrows move,
 * Enter selects, Esc closes. Token-only surfaces, no keyframes.
 */
export default function ProfileRangeMenu(p: Props): React.ReactElement {
  const { value, onChange, labelId } = p;
  const buttonId = useId();
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(() => indexFor(value));
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);

  // Keep the highlight on the committed value while closed so reopening
  // lands on the current choice; preserve in-flight highlight while open.
  useEffect(() => {
    if (!open) setActive(indexFor(value));
  }, [value, open]);

  // Outside click closes without stealing focus.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node | null;
      if (!t) return;
      const btn = buttonRef.current;
      const list = listRef.current;
      if (btn && btn.contains(t)) return;
      if (list && list.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const commit = (next: ProfileRange): void => {
    setOpen(false);
    if (next !== value) onChange(next);
    buttonRef.current?.focus();
  };

  const openMenu = (at?: number): void => {
    setActive(typeof at === "number" ? at : indexFor(value));
    setOpen(true);
  };

  const onButtonKey = (e: React.KeyboardEvent): void => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (open) {
        commit(OPTIONS[active].value);
      } else {
        openMenu();
      }
      return;
    }
    if (e.key === "ArrowDown" || e.key === "Down") {
      e.preventDefault();
      if (!open) {
        openMenu((indexFor(value) + 1) % OPTIONS.length);
      } else {
        setActive((a) => (a + 1) % OPTIONS.length);
      }
      return;
    }
    if (e.key === "ArrowUp" || e.key === "Up") {
      e.preventDefault();
      if (!open) {
        openMenu((indexFor(value) - 1 + OPTIONS.length) % OPTIONS.length);
      } else {
        setActive((a) => (a - 1 + OPTIONS.length) % OPTIONS.length);
      }
      return;
    }
    if (e.key === "Escape" || e.key === "Esc") {
      if (open) {
        e.preventDefault();
        setOpen(false);
      }
      return;
    }
    if (e.key === "Home" && open) {
      e.preventDefault();
      setActive(0);
      return;
    }
    if (e.key === "End" && open) {
      e.preventDefault();
      setActive(OPTIONS.length - 1);
    }
  };

  const onListKey = (e: React.KeyboardEvent): void => {
    if (e.key === "Escape" || e.key === "Esc") {
      e.preventDefault();
      setOpen(false);
      buttonRef.current?.focus();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "Down") {
      e.preventDefault();
      setActive((a) => (a + 1) % OPTIONS.length);
      return;
    }
    if (e.key === "ArrowUp" || e.key === "Up") {
      e.preventDefault();
      setActive((a) => (a - 1 + OPTIONS.length) % OPTIONS.length);
      return;
    }
    if (e.key === "Home") {
      e.preventDefault();
      setActive(0);
      return;
    }
    if (e.key === "End") {
      e.preventDefault();
      setActive(OPTIONS.length - 1);
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      commit(OPTIONS[active].value);
    }
  };

  return (
    <>
      <button
        ref={buttonRef}
        id={buttonId}
        type="button"
        className="range-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-labelledby={`${labelId} ${buttonId}`}
        onClick={() => {
          if (open) setOpen(false);
          else openMenu();
        }}
        onKeyDown={onButtonKey}
      >
        {labelFor(value)}
      </button>
      <ul
        ref={listRef}
        id={listId}
        className="range-listbox"
        role="listbox"
        aria-labelledby={labelId}
        hidden={!open}
        onKeyDown={onListKey}
      >
        {OPTIONS.map((o, i) => (
          <li
            key={o.value}
            role="option"
            id={`${listId}-opt-${o.value}`}
            data-value={o.value}
            aria-selected={o.value === value}
            tabIndex={-1}
            className={i === active ? "is-active" : undefined}
            onClick={() => commit(o.value)}
            onMouseEnter={() => setActive(i)}
          >
            {o.label}
          </li>
        ))}
      </ul>
    </>
  );
}
