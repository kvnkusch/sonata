ALTER TABLE `step` ADD `parent_step_id` text REFERENCES `step`(`step_id`);
--> statement-breakpoint
ALTER TABLE `step` ADD `work_key` text CHECK ((`parent_step_id` IS NULL AND `work_key` IS NULL) OR (`parent_step_id` IS NOT NULL AND `work_key` IS NOT NULL));
--> statement-breakpoint
ALTER TABLE `step` ADD `wait_spec_json` text;
--> statement-breakpoint
ALTER TABLE `step` ADD `wait_snapshot_json` text;
--> statement-breakpoint
ALTER TABLE `step` ADD `block_payload_json` text;
--> statement-breakpoint
ALTER TABLE `step` ADD `orphaned_reason_json` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_step_child_identity` ON `step` (`parent_step_id`,`step_key`,`work_key`);
