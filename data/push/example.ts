import type { PushBackend, PushStatus } from "./types";

// The example build has no backend and no owner to notify: notifications are off, and nothing is shown or asked.
const off: PushStatus = { accountsMode: false, signedIn: true, registered: false };
const refuse = async () => { throw new Error("Notifications are not available with example data."); };

export const exampleBackend: PushBackend = {
  useStatus: () => off,
  register: refuse,
  refresh: refuse,
  remove: async () => {},
};
