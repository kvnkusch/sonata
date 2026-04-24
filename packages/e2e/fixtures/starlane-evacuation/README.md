# Starlane Evacuation Board

This fixture models a convoy planner that dispatches survey squadrons to three sectors before mission control can publish an evacuation plan.

The e2e test copies this fixture into a temp sandbox, links the copied `ops/` directory, and lets Sonata write runtime artifacts into the copied `ops/tasks/` directory.
