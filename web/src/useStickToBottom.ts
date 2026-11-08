import { useCallback, useEffect, useRef, useState } from "react";

// "Follow the output" behaviour for a scrolling box, like a terminal:
//  - while you are at the bottom, new content keeps the box scrolled to the bottom (even when an existing
//    item grows, such as streaming command output);
//  - scrolling UP pauses following; scrolling back to the bottom, or calling jump(), resumes it;
//  - a size change of the box itself (a hidden tab shown again, a resized window) also keeps the bottom in view.
// Attach scrollRef to the element that scrolls, and contentRef to ONE child that holds all the content.
export function useStickToBottom<S extends HTMLElement = HTMLDivElement>() {
  const scrollRef = useRef<S>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const lastTop = useRef(0);
  const [following, setFollowing] = useState(true);

  const setFollow = useCallback((value: boolean) => {
    if (followRef.current === value) return;
    followRef.current = value;
    setFollowing(value);
  }, []);

  const toBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    lastTop.current = el.scrollTop;
  }, []);

  // Only an upward movement away from the bottom pauses following. Content that grows does not move scrollTop,
  // so growth can never pause it by accident.
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const wentUp = el.scrollTop < lastTop.current - 1;
    lastTop.current = el.scrollTop;
    if (distance < 32) setFollow(true);
    else if (wentUp) setFollow(false);
  }, [setFollow]);

  useEffect(() => {
    const content = contentRef.current;
    const scroller = scrollRef.current;
    if (!content || !scroller) return;
    const observer = new ResizeObserver(() => {
      if (followRef.current) toBottom();
    });
    observer.observe(content);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [toBottom]);

  const jump = useCallback(() => {
    setFollow(true);
    toBottom();
  }, [setFollow, toBottom]);

  return { scrollRef, contentRef, following, onScroll, jump };
}
