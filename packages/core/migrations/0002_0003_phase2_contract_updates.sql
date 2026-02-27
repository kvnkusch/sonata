DROP INDEX `uq_artifact_task_step_name_hash`;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_artifact_task_step_name` ON `artifact` (`task_id`,`step_id`,`artifact_name`);--> statement-breakpoint
ALTER TABLE `task_event` ADD `event_version` integer DEFAULT 1 NOT NULL;