CREATE TABLE `project` (
	`project_id` text PRIMARY KEY NOT NULL,
	`project_root_realpath` text NOT NULL,
	`ops_root_realpath` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_project_root_realpath_unique` ON `project` (`project_root_realpath`);--> statement-breakpoint
CREATE TABLE `step` (
	`step_id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`step_key` text NOT NULL,
	`step_index` integer NOT NULL,
	`status` text NOT NULL,
	`session_id` text,
	`started_at` integer NOT NULL,
	`completed_at` integer,
	`completion_payload_json` text,
	FOREIGN KEY (`task_id`) REFERENCES `task`(`task_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `step_session_id_unique` ON `step` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_step_task_index` ON `step` (`task_id`,`step_index`);--> statement-breakpoint
CREATE INDEX `idx_step_task_status` ON `step` (`task_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_step_task_index` ON `step` (`task_id`,`step_index`);--> statement-breakpoint
CREATE TABLE `task` (
	`task_id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`workflow_name` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`project_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_task_project_status_created` ON `task` (`project_id`,`status`,`created_at`);