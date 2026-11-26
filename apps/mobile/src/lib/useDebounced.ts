// Debounce a value by `delay` ms. Used by search inputs so every keystroke
// doesn't fire a network round-trip. Returns the latest value once the user
// has stopped typing for `delay`.

import { useEffect, useState } from "react";

export function useDebounced<T>(value: T, delay = 250): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);
  return debounced;
}
