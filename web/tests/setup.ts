import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// jsdom doesn't implement scrollIntoView; App.tsx calls it to auto-scroll the chat.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

// globals: false in vite.config.ts, so React Testing Library's automatic
// afterEach(cleanup) registration doesn't kick in — wire it up explicitly.
afterEach(() => {
  cleanup();
});
