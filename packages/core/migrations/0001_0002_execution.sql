CREATE TABLE `artifact` (
	`artifact_id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`step_id` text NOT NULL,
	`artifact_name` text NOT NULL,
	`artifact_kind` text NOT NULL,
	`relative_path` text NOT NULL,
	`content_hash` text NOT NULL,
	`session_id` text,
	`written_at` integer NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `task`(`task_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`step_id`) REFERENCES `step`(`step_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_artifact_task_step_written` ON `artifact` (`task_id`,`step_id`,`written_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_artifact_task_step_name_hash` ON `artifact` (`task_id`,`step_id`,`artifact_name`,`content_hash`);--> statement-breakpoint
CREATE TABLE `task_event` (
	`event_id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`step_id` text,
	`event_type` text NOT NULL,
	`event_payload_json` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `task`(`task_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`step_id`) REFERENCES `step`(`step_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_task_event_task_created` ON `task_event` (`task_id`,`created_at`);