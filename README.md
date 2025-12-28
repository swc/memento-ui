# Memento UI

`memento-ui` houses the standalone monitor app that tracks agent status, chats, and activity across any Loom story/task workflow.

## Goals

- Provide a web surface that can watch any companion workspace (`<project>-memento`) and surface approvals, chats, notifications, and meeting controls.
- Serve as the control center where the Project Manager can approve stories/tasks, notify agents, and coordinate baton handoffs instead of being embedded inside a single product repo.

## Getting started

```bash
cd ../loom-memento
# ensure the state repo is up-to-date
git pull
cd ../memento-ui
npm install
npm run dev
```

The UI expects the configured companion repo to expose the usual `state/`, `tasks/`, `handoffs/`, and `activity/` folders accessible relative to `loom-memento`. Update `src/config.js` (or equivalent) if you need to point it to another project workspace.

## What's next

- Routing approvals/notifications from the UI so project managers can approve work directly inside this app.
- Adding chat, meeting, and activity controls that post directly to the `loom-memento` inboxes and notifications.
- Running the monitor against multiple projects by swapping the target workspace via configuration or query parameters.

