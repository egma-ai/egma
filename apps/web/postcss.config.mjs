/**
 * The one build step Tailwind needs.
 *
 * Next reads this file itself, so the utilities are compiled by the same
 * `next dev` and `next build` everything else already runs. There is no second
 * command to remember and no watcher to leave running.
 */
const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};

export default config;
