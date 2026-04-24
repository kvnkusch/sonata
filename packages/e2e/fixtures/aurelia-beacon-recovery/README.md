# Aurelia Beacon Recovery

This fixture models an OpenCode-assisted repair step that may block on a live operator, lose its session, and recover by retrying in a fresh session.

The e2e test copies this fixture into a temp sandbox before running, so runtime artifacts land in the copied `ops/tasks/` directory instead of the committed fixture.
