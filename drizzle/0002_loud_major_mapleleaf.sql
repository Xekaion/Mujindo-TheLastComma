CREATE TABLE IF NOT EXISTS `economy_listing_expiry_commands` (
	`id` text PRIMARY KEY NOT NULL,
	`listing_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`listing_id`) REFERENCES `economy_listings`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `economy_listing_expiry_listing` ON `economy_listing_expiry_commands` (`listing_id`);
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS economy_listing_expiry_no_update
BEFORE UPDATE ON economy_listing_expiry_commands BEGIN
  SELECT RAISE(ABORT, 'immutable_listing_expiry_command');
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS economy_buy_listing_after;
--> statement-breakpoint
CREATE TRIGGER economy_buy_listing_after
AFTER INSERT ON economy_commands WHEN NEW.action = 'buy_listing'
BEGIN
  UPDATE economy_wallets SET ash_available=ash_available-NEW.price_ash,version=version+1,updated_at=NEW.created_at WHERE account_id=NEW.actor_account_id;
  UPDATE economy_wallets SET ash_available=ash_available+NEW.price_ash,version=version+1,updated_at=NEW.created_at WHERE account_id=(SELECT seller_account_id FROM economy_listings WHERE id=NEW.listing_id);
  UPDATE economy_items SET owner_account_id=NEW.actor_account_id,state='inventory',version=version+1,updated_at=NEW.created_at WHERE id=(SELECT item_id FROM economy_listings WHERE id=NEW.listing_id);
  UPDATE economy_listings SET buyer_account_id=NEW.actor_account_id,status='sold',version=version+1,closed_at=NEW.created_at WHERE id=NEW.listing_id;
  INSERT INTO economy_auction_trades(id,listing_id,item_id,seller_account_id,buyer_account_id,price_ash,created_at)
    SELECT NEW.result_ref_id,l.id,l.item_id,l.seller_account_id,NEW.actor_account_id,NEW.price_ash,NEW.created_at FROM economy_listings l WHERE l.id=NEW.listing_id;
  INSERT INTO economy_ledger(id,operation_id,account_id,currency,available_delta,reserved_delta,locked_delta,reason,reference_type,reference_id,created_at)
    VALUES(NEW.id||':buyer',NEW.id,NEW.actor_account_id,'ash',-NEW.price_ash,0,0,'auction_buy','listing',NEW.listing_id,NEW.created_at);
  INSERT INTO economy_ledger(id,operation_id,account_id,currency,available_delta,reserved_delta,locked_delta,reason,reference_type,reference_id,created_at)
    SELECT NEW.id||':seller',NEW.id,seller_account_id,'ash',NEW.price_ash,0,0,'auction_sell','listing',NEW.listing_id,NEW.created_at FROM economy_listings WHERE id=NEW.listing_id;
  INSERT INTO economy_audit_events(id,actor_account_id,target_account_id,action,object_type,object_id,request_id,idempotency_key,request_hash,metadata_json,created_at)
    SELECT NEW.id||':audit',NEW.actor_account_id,seller_account_id,'buy_listing','listing',NEW.listing_id,NEW.id,NEW.idempotency_key,NEW.request_hash,'{}',NEW.created_at FROM economy_listings WHERE id=NEW.listing_id;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS economy_listing_expiry_no_delete
BEFORE DELETE ON economy_listing_expiry_commands BEGIN
  SELECT RAISE(ABORT, 'immutable_listing_expiry_command');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS economy_listing_expiry_after
AFTER INSERT ON economy_listing_expiry_commands
WHEN EXISTS(SELECT 1 FROM economy_listings WHERE id=NEW.listing_id AND status='open' AND expires_at<=NEW.created_at)
BEGIN
  UPDATE economy_items
     SET state='inventory',version=version+1,updated_at=NEW.created_at
   WHERE id=(SELECT item_id FROM economy_listings WHERE id=NEW.listing_id)
     AND state='escrow';
  UPDATE economy_listings
     SET status='expired',version=version+1,closed_at=NEW.created_at
   WHERE id=NEW.listing_id AND status='open';
  INSERT INTO economy_audit_events(id,actor_account_id,action,object_type,object_id,request_id,metadata_json,created_at)
    SELECT NEW.id||':audit',seller_account_id,'expire_listing','listing',id,NEW.id,'{}',NEW.created_at
      FROM economy_listings WHERE id=NEW.listing_id;
END;
