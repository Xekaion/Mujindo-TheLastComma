CREATE TRIGGER IF NOT EXISTS economy_ledger_no_update
BEFORE UPDATE ON economy_ledger BEGIN
  SELECT RAISE(ABORT, 'immutable_ledger');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS economy_ledger_no_delete
BEFORE DELETE ON economy_ledger BEGIN
  SELECT RAISE(ABORT, 'immutable_ledger');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS economy_payment_finalize_before
BEFORE INSERT ON economy_payment_finalize_commands
BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM economy_payment_orders p WHERE p.id=NEW.payment_order_id AND p.account_id=NEW.account_id AND p.status='authorized') THEN RAISE(ABORT,'payment_not_finalizable') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM economy_accounts a WHERE a.id=NEW.account_id AND a.status='active' AND a.wallet_frozen=0 AND a.steam_ownership_verified=1) THEN RAISE(ABORT,'payment_account_blocked') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM economy_sanctions s WHERE s.account_id=NEW.account_id AND s.revoked_at IS NULL AND s.starts_at<=NEW.created_at AND (s.expires_at IS NULL OR s.expires_at>NEW.created_at) AND s.scope IN ('login','payment','wallet')) THEN RAISE(ABORT,'payment_account_sanctioned') END;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS economy_payment_finalize_after
AFTER INSERT ON economy_payment_finalize_commands
BEGIN
  UPDATE economy_payment_orders SET status='finalized',finalized_at=NEW.created_at WHERE id=NEW.payment_order_id;
  UPDATE economy_wallets SET gold_locked=gold_locked+(SELECT gold_amount FROM economy_payment_orders WHERE id=NEW.payment_order_id),version=version+1,updated_at=NEW.created_at WHERE account_id=NEW.account_id;
  INSERT INTO economy_gold_lots(id,account_id,source,source_id,amount,remaining,state,tradeable_at,created_at)
    SELECT NEW.id||':lot',NEW.account_id,'steam_payment',p.id,p.gold_amount,p.gold_amount,'locked',NEW.created_at+259200000,NEW.created_at FROM economy_payment_orders p WHERE p.id=NEW.payment_order_id;
  INSERT INTO economy_ledger(id,operation_id,account_id,currency,available_delta,reserved_delta,locked_delta,reason,reference_type,reference_id,created_at)
    SELECT NEW.id||':ledger',NEW.id,NEW.account_id,'gold',0,0,p.gold_amount,'steam_payment_mint','payment_order',p.id,NEW.created_at FROM economy_payment_orders p WHERE p.id=NEW.payment_order_id;
  INSERT INTO economy_audit_events(id,actor_account_id,action,object_type,object_id,request_id,idempotency_key,request_hash,metadata_json,created_at)
    VALUES(NEW.id||':audit',NEW.account_id,'steam_payment_finalize','payment_order',NEW.payment_order_id,NEW.id,NEW.idempotency_key,NEW.request_hash,'{"hold_hours":72}',NEW.created_at);
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS economy_audit_no_update
BEFORE UPDATE ON economy_audit_events BEGIN
  SELECT RAISE(ABORT, 'immutable_audit');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS economy_audit_no_delete
BEFORE DELETE ON economy_audit_events BEGIN
  SELECT RAISE(ABORT, 'immutable_audit');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS economy_command_no_update
BEFORE UPDATE ON economy_commands BEGIN
  SELECT RAISE(ABORT, 'immutable_command');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS economy_command_no_delete
BEFORE DELETE ON economy_commands BEGIN
  SELECT RAISE(ABORT, 'immutable_command');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS economy_listing_expiry_no_update
BEFORE UPDATE ON economy_listing_expiry_commands BEGIN
  SELECT RAISE(ABORT, 'immutable_listing_expiry_command');
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
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS economy_gold_release_after
AFTER INSERT ON economy_gold_release_commands
WHEN (SELECT COALESCE(SUM(remaining),0) FROM economy_gold_lots
      WHERE account_id = NEW.account_id AND state = 'locked' AND tradeable_at <= NEW.created_at) > 0
BEGIN
  UPDATE economy_wallets
     SET gold_available = gold_available + (SELECT COALESCE(SUM(remaining),0) FROM economy_gold_lots WHERE account_id=NEW.account_id AND state='locked' AND tradeable_at<=NEW.created_at),
         gold_locked = gold_locked - (SELECT COALESCE(SUM(remaining),0) FROM economy_gold_lots WHERE account_id=NEW.account_id AND state='locked' AND tradeable_at<=NEW.created_at),
         version = version + 1,
         updated_at = NEW.created_at
   WHERE account_id = NEW.account_id;
  INSERT INTO economy_ledger(id,operation_id,account_id,currency,available_delta,reserved_delta,locked_delta,reason,reference_type,reference_id,created_at)
    SELECT NEW.id || ':gold', NEW.id, NEW.account_id, 'gold', COALESCE(SUM(remaining),0), 0, -COALESCE(SUM(remaining),0), 'gold_hold_release', 'gold_release', NEW.id, NEW.created_at
      FROM economy_gold_lots WHERE account_id=NEW.account_id AND state='locked' AND tradeable_at<=NEW.created_at;
  UPDATE economy_gold_lots SET state='available', released_at=NEW.created_at
   WHERE account_id=NEW.account_id AND state='locked' AND tradeable_at<=NEW.created_at;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS economy_list_item_before
BEFORE INSERT ON economy_commands WHEN NEW.action = 'list_item'
BEGIN
  SELECT CASE WHEN NEW.item_id IS NULL OR NEW.price_ash NOT BETWEEN 1 AND 1000000000000 OR NEW.expires_at <= NEW.created_at THEN RAISE(ABORT,'invalid_list_item') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM economy_accounts a WHERE a.id=NEW.actor_account_id AND a.status='active' AND a.trade_eligible=1 AND a.steam_ownership_verified=1 AND a.wallet_frozen=0) THEN RAISE(ABORT,'account_not_trade_eligible') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM economy_sanctions s WHERE s.account_id=NEW.actor_account_id AND s.revoked_at IS NULL AND s.starts_at<=NEW.created_at AND (s.expires_at IS NULL OR s.expires_at>NEW.created_at) AND s.scope IN ('market','wallet')) THEN RAISE(ABORT,'account_sanctioned') END;
  SELECT CASE WHEN (SELECT COUNT(*) FROM economy_listings WHERE seller_account_id=NEW.actor_account_id AND status='open')>=200 THEN RAISE(ABORT,'open_listing_limit') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM economy_items i WHERE i.id=NEW.item_id AND i.owner_account_id=NEW.actor_account_id AND i.state='inventory' AND i.tradeable=1 AND i.version=NEW.expected_version) THEN RAISE(ABORT,'item_not_owned_or_version') END;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS economy_list_item_after
AFTER INSERT ON economy_commands WHEN NEW.action = 'list_item'
BEGIN
  UPDATE economy_items SET state='escrow',version=version+1,updated_at=NEW.created_at WHERE id=NEW.item_id;
  INSERT INTO economy_listings(id,item_id,seller_account_id,price_ash,status,version,created_at,expires_at)
    VALUES(NEW.result_ref_id,NEW.item_id,NEW.actor_account_id,NEW.price_ash,'open',0,NEW.created_at,NEW.expires_at);
  INSERT INTO economy_audit_events(id,actor_account_id,action,object_type,object_id,request_id,idempotency_key,request_hash,metadata_json,created_at)
    VALUES(NEW.id||':audit',NEW.actor_account_id,'list_item','listing',NEW.result_ref_id,NEW.id,NEW.idempotency_key,NEW.request_hash,'{}',NEW.created_at);
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS economy_buy_listing_before
BEFORE INSERT ON economy_commands WHEN NEW.action = 'buy_listing'
BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM economy_accounts a WHERE a.id=NEW.actor_account_id AND a.status='active' AND a.trade_eligible=1 AND a.steam_ownership_verified=1 AND a.wallet_frozen=0) THEN RAISE(ABORT,'account_not_trade_eligible') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM economy_sanctions s WHERE s.account_id=NEW.actor_account_id AND s.revoked_at IS NULL AND s.starts_at<=NEW.created_at AND (s.expires_at IS NULL OR s.expires_at>NEW.created_at) AND s.scope IN ('market','wallet')) THEN RAISE(ABORT,'account_sanctioned') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM economy_listings l JOIN economy_items i ON i.id=l.item_id WHERE l.id=NEW.listing_id AND l.status='open' AND l.expires_at>NEW.created_at AND l.version=NEW.expected_version AND l.price_ash=NEW.price_ash AND l.seller_account_id<>NEW.actor_account_id AND i.state='escrow' AND i.owner_account_id=l.seller_account_id) THEN RAISE(ABORT,'listing_unavailable_or_self_trade') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM economy_wallets w JOIN economy_listings l ON l.id=NEW.listing_id WHERE w.account_id=NEW.actor_account_id AND w.ash_available>=l.price_ash) THEN RAISE(ABORT,'insufficient_ash') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM economy_listings l JOIN economy_accounts a ON a.id=l.seller_account_id JOIN economy_wallets w ON w.account_id=a.id WHERE l.id=NEW.listing_id AND a.status='active' AND a.trade_eligible=1 AND a.steam_ownership_verified=1 AND a.wallet_frozen=0 AND w.ash_available+l.price_ash<=9000000000000) THEN RAISE(ABORT,'seller_ineligible_or_overflow') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM economy_listings l JOIN economy_sanctions s ON s.account_id=l.seller_account_id WHERE l.id=NEW.listing_id AND s.revoked_at IS NULL AND s.starts_at<=NEW.created_at AND (s.expires_at IS NULL OR s.expires_at>NEW.created_at) AND s.scope IN ('market','wallet')) THEN RAISE(ABORT,'seller_sanctioned') END;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS economy_buy_listing_after
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
CREATE TRIGGER IF NOT EXISTS economy_cancel_listing_before
BEFORE INSERT ON economy_commands WHEN NEW.action = 'cancel_listing'
BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM economy_listings WHERE id=NEW.listing_id AND seller_account_id=NEW.actor_account_id AND status='open' AND version=NEW.expected_version) THEN RAISE(ABORT,'listing_not_owned_or_version') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM economy_sanctions s WHERE s.account_id=NEW.actor_account_id AND s.revoked_at IS NULL AND s.starts_at<=NEW.created_at AND (s.expires_at IS NULL OR s.expires_at>NEW.created_at) AND s.scope IN ('market','wallet')) THEN RAISE(ABORT,'account_sanctioned') END;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS economy_cancel_listing_after
AFTER INSERT ON economy_commands WHEN NEW.action = 'cancel_listing'
BEGIN
  UPDATE economy_items SET state='inventory',version=version+1,updated_at=NEW.created_at WHERE id=(SELECT item_id FROM economy_listings WHERE id=NEW.listing_id);
  UPDATE economy_listings SET status='cancelled',version=version+1,closed_at=NEW.created_at WHERE id=NEW.listing_id;
  INSERT INTO economy_audit_events(id,actor_account_id,action,object_type,object_id,request_id,idempotency_key,request_hash,metadata_json,created_at)
    VALUES(NEW.id||':audit',NEW.actor_account_id,'cancel_listing','listing',NEW.listing_id,NEW.id,NEW.idempotency_key,NEW.request_hash,'{}',NEW.created_at);
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS economy_place_exchange_before
BEFORE INSERT ON economy_commands WHEN NEW.action = 'place_exchange'
BEGIN
  SELECT CASE WHEN NEW.side IS NULL OR NEW.gold_amount NOT BETWEEN 1 AND 10000000 OR NEW.price_ash NOT BETWEEN 1 AND 1000000000 OR NEW.gold_amount*NEW.price_ash>9000000000000 THEN RAISE(ABORT,'invalid_exchange_order') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM economy_accounts a WHERE a.id=NEW.actor_account_id AND a.status='active' AND a.trade_eligible=1 AND a.steam_ownership_verified=1 AND a.wallet_frozen=0) THEN RAISE(ABORT,'account_not_trade_eligible') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM economy_sanctions s WHERE s.account_id=NEW.actor_account_id AND s.revoked_at IS NULL AND s.starts_at<=NEW.created_at AND (s.expires_at IS NULL OR s.expires_at>NEW.created_at) AND s.scope IN ('exchange','wallet')) THEN RAISE(ABORT,'account_sanctioned') END;
  SELECT CASE WHEN (SELECT COUNT(*) FROM economy_exchange_orders WHERE account_id=NEW.actor_account_id AND status IN ('open','partially_filled'))>=100 THEN RAISE(ABORT,'open_exchange_order_limit') END;
  SELECT CASE WHEN NEW.side='buy_gold' AND NOT EXISTS(SELECT 1 FROM economy_wallets WHERE account_id=NEW.actor_account_id AND ash_available>=NEW.gold_amount*NEW.price_ash) THEN RAISE(ABORT,'insufficient_ash') END;
  SELECT CASE WHEN NEW.side='sell_gold' AND NOT EXISTS(SELECT 1 FROM economy_wallets WHERE account_id=NEW.actor_account_id AND gold_available>=NEW.gold_amount) THEN RAISE(ABORT,'insufficient_mature_gold') END;
  SELECT CASE WHEN NEW.side='sell_gold' AND (SELECT COALESCE(SUM(remaining),0) FROM economy_gold_lots WHERE account_id=NEW.actor_account_id AND state='available' AND tradeable_at<=NEW.created_at)<NEW.gold_amount THEN RAISE(ABORT,'insufficient_mature_gold_lots') END;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS economy_place_exchange_after
AFTER INSERT ON economy_commands WHEN NEW.action = 'place_exchange'
BEGIN
  UPDATE economy_wallets SET
    ash_available=ash_available-IIF(NEW.side='buy_gold',NEW.gold_amount*NEW.price_ash,0),
    ash_reserved=ash_reserved+IIF(NEW.side='buy_gold',NEW.gold_amount*NEW.price_ash,0),
    gold_available=gold_available-IIF(NEW.side='sell_gold',NEW.gold_amount,0),
    gold_reserved=gold_reserved+IIF(NEW.side='sell_gold',NEW.gold_amount,0),
    version=version+1,updated_at=NEW.created_at WHERE account_id=NEW.actor_account_id;
  INSERT INTO economy_exchange_orders(id,account_id,side,price_ash_per_gold,gold_initial,gold_remaining,ash_reserved_remaining,gold_reserved_remaining,status,version,created_at,updated_at)
    VALUES(NEW.result_ref_id,NEW.actor_account_id,NEW.side,NEW.price_ash,NEW.gold_amount,NEW.gold_amount,IIF(NEW.side='buy_gold',NEW.gold_amount*NEW.price_ash,0),IIF(NEW.side='sell_gold',NEW.gold_amount,0),'open',0,NEW.created_at,NEW.created_at);
  INSERT INTO economy_ledger(id,operation_id,account_id,currency,available_delta,reserved_delta,locked_delta,reason,reference_type,reference_id,created_at)
    VALUES(NEW.id||':reserve',NEW.id,NEW.actor_account_id,IIF(NEW.side='buy_gold','ash','gold'),IIF(NEW.side='buy_gold',-NEW.gold_amount*NEW.price_ash,-NEW.gold_amount),IIF(NEW.side='buy_gold',NEW.gold_amount*NEW.price_ash,NEW.gold_amount),0,'exchange_reserve','exchange_order',NEW.result_ref_id,NEW.created_at);
  INSERT INTO economy_exchange_order_gold_lots(order_id,lot_id,amount_reserved,amount_remaining)
    SELECT NEW.result_ref_id,id,take_amount,take_amount FROM (
      SELECT id,MIN(remaining,MAX(0,NEW.gold_amount-COALESCE(SUM(remaining) OVER (ORDER BY tradeable_at,created_at,id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0))) AS take_amount,
             COALESCE(SUM(remaining) OVER (ORDER BY tradeable_at,created_at,id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0) AS prior_amount
        FROM economy_gold_lots WHERE NEW.side='sell_gold' AND account_id=NEW.actor_account_id AND state='available' AND tradeable_at<=NEW.created_at AND remaining>0
    ) WHERE prior_amount<NEW.gold_amount AND take_amount>0;
  UPDATE economy_gold_lots SET remaining=remaining-COALESCE((SELECT amount_reserved FROM economy_exchange_order_gold_lots a WHERE a.order_id=NEW.result_ref_id AND a.lot_id=economy_gold_lots.id),0),state=IIF(remaining-COALESCE((SELECT amount_reserved FROM economy_exchange_order_gold_lots a WHERE a.order_id=NEW.result_ref_id AND a.lot_id=economy_gold_lots.id),0)=0,'reserved',state)
    WHERE id IN (SELECT lot_id FROM economy_exchange_order_gold_lots WHERE order_id=NEW.result_ref_id);
  INSERT INTO economy_audit_events(id,actor_account_id,action,object_type,object_id,request_id,idempotency_key,request_hash,metadata_json,created_at)
    VALUES(NEW.id||':audit',NEW.actor_account_id,'place_exchange','exchange_order',NEW.result_ref_id,NEW.id,NEW.idempotency_key,NEW.request_hash,'{}',NEW.created_at);
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS economy_fill_exchange_before
BEFORE INSERT ON economy_commands WHEN NEW.action = 'fill_exchange'
BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM economy_accounts a WHERE a.id=NEW.actor_account_id AND a.status='active' AND a.trade_eligible=1 AND a.steam_ownership_verified=1 AND a.wallet_frozen=0) THEN RAISE(ABORT,'account_not_trade_eligible') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM economy_sanctions s WHERE s.account_id=NEW.actor_account_id AND s.revoked_at IS NULL AND s.starts_at<=NEW.created_at AND (s.expires_at IS NULL OR s.expires_at>NEW.created_at) AND s.scope IN ('exchange','wallet')) THEN RAISE(ABORT,'account_sanctioned') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM economy_exchange_orders o JOIN economy_accounts a ON a.id=o.account_id WHERE o.id=NEW.order_id AND o.account_id<>NEW.actor_account_id AND o.status IN ('open','partially_filled') AND o.version=NEW.expected_version AND o.price_ash_per_gold=NEW.price_ash AND o.gold_remaining>=NEW.gold_amount AND a.status='active' AND a.trade_eligible=1 AND a.steam_ownership_verified=1 AND a.wallet_frozen=0) THEN RAISE(ABORT,'order_unavailable_or_self_trade') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM economy_exchange_orders o JOIN economy_sanctions s ON s.account_id=o.account_id WHERE o.id=NEW.order_id AND s.revoked_at IS NULL AND s.starts_at<=NEW.created_at AND (s.expires_at IS NULL OR s.expires_at>NEW.created_at) AND s.scope IN ('exchange','wallet')) THEN RAISE(ABORT,'maker_sanctioned') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM economy_exchange_orders o WHERE o.id=NEW.order_id AND o.side='sell_gold') AND NOT EXISTS(SELECT 1 FROM economy_wallets WHERE account_id=NEW.actor_account_id AND ash_available>=NEW.gold_amount*NEW.price_ash) THEN RAISE(ABORT,'insufficient_ash') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM economy_exchange_orders o WHERE o.id=NEW.order_id AND o.side='buy_gold') AND NOT EXISTS(SELECT 1 FROM economy_wallets WHERE account_id=NEW.actor_account_id AND gold_available>=NEW.gold_amount) THEN RAISE(ABORT,'insufficient_mature_gold') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM economy_exchange_orders o WHERE o.id=NEW.order_id AND o.side='buy_gold') AND (SELECT COALESCE(SUM(remaining),0) FROM economy_gold_lots WHERE account_id=NEW.actor_account_id AND state='available' AND tradeable_at<=NEW.created_at)<NEW.gold_amount THEN RAISE(ABORT,'insufficient_mature_gold_lots') END;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS economy_fill_exchange_after
AFTER INSERT ON economy_commands WHEN NEW.action = 'fill_exchange'
BEGIN
  UPDATE economy_wallets SET
    ash_available=ash_available + IIF((SELECT side FROM economy_exchange_orders WHERE id=NEW.order_id)='sell_gold',NEW.gold_amount*NEW.price_ash,0),
    ash_reserved=ash_reserved - IIF((SELECT side FROM economy_exchange_orders WHERE id=NEW.order_id)='buy_gold',NEW.gold_amount*NEW.price_ash,0),
    gold_available=gold_available + IIF((SELECT side FROM economy_exchange_orders WHERE id=NEW.order_id)='buy_gold',NEW.gold_amount,0),
    gold_reserved=gold_reserved - IIF((SELECT side FROM economy_exchange_orders WHERE id=NEW.order_id)='sell_gold',NEW.gold_amount,0),
    version=version+1,updated_at=NEW.created_at WHERE account_id=(SELECT account_id FROM economy_exchange_orders WHERE id=NEW.order_id);
  UPDATE economy_wallets SET
    ash_available=ash_available + IIF((SELECT side FROM economy_exchange_orders WHERE id=NEW.order_id)='buy_gold',NEW.gold_amount*NEW.price_ash,-NEW.gold_amount*NEW.price_ash),
    gold_available=gold_available + IIF((SELECT side FROM economy_exchange_orders WHERE id=NEW.order_id)='sell_gold',NEW.gold_amount,-NEW.gold_amount),
    version=version+1,updated_at=NEW.created_at WHERE account_id=NEW.actor_account_id;
  INSERT INTO economy_exchange_fills(id,maker_order_id,maker_account_id,taker_account_id,buyer_account_id,seller_account_id,gold_amount,ash_amount,price_ash_per_gold,created_at)
    SELECT NEW.result_ref_id,o.id,o.account_id,NEW.actor_account_id,IIF(o.side='buy_gold',o.account_id,NEW.actor_account_id),IIF(o.side='sell_gold',o.account_id,NEW.actor_account_id),NEW.gold_amount,NEW.gold_amount*NEW.price_ash,NEW.price_ash,NEW.created_at FROM economy_exchange_orders o WHERE o.id=NEW.order_id;
  INSERT INTO economy_gold_lot_transfers(id,fill_id,source_lot_id,recipient_account_id,amount,created_at)
    SELECT NEW.result_ref_id||':'||lot_id,NEW.result_ref_id,lot_id,NEW.actor_account_id,take_amount,NEW.created_at FROM (
      SELECT lot_id,MIN(amount_remaining,MAX(0,NEW.gold_amount-COALESCE(SUM(amount_remaining) OVER (ORDER BY lot_id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0))) AS take_amount,
             COALESCE(SUM(amount_remaining) OVER (ORDER BY lot_id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0) AS prior_amount
        FROM economy_exchange_order_gold_lots WHERE order_id=NEW.order_id AND (SELECT side FROM economy_exchange_orders WHERE id=NEW.order_id)='sell_gold' AND amount_remaining>0
    ) WHERE prior_amount<NEW.gold_amount AND take_amount>0;
  INSERT INTO economy_gold_lot_transfers(id,fill_id,source_lot_id,recipient_account_id,amount,created_at)
    SELECT NEW.result_ref_id||':'||id,NEW.result_ref_id,id,(SELECT account_id FROM economy_exchange_orders WHERE id=NEW.order_id),take_amount,NEW.created_at FROM (
      SELECT id,MIN(remaining,MAX(0,NEW.gold_amount-COALESCE(SUM(remaining) OVER (ORDER BY tradeable_at,created_at,id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0))) AS take_amount,
             COALESCE(SUM(remaining) OVER (ORDER BY tradeable_at,created_at,id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0) AS prior_amount
        FROM economy_gold_lots WHERE (SELECT side FROM economy_exchange_orders WHERE id=NEW.order_id)='buy_gold' AND account_id=NEW.actor_account_id AND state='available' AND tradeable_at<=NEW.created_at AND remaining>0
    ) WHERE prior_amount<NEW.gold_amount AND take_amount>0;
  UPDATE economy_exchange_order_gold_lots SET amount_remaining=amount_remaining-COALESCE((SELECT amount FROM economy_gold_lot_transfers t WHERE t.fill_id=NEW.result_ref_id AND t.source_lot_id=economy_exchange_order_gold_lots.lot_id),0) WHERE order_id=NEW.order_id;
  UPDATE economy_gold_lots SET state='spent'
    WHERE remaining=0
      AND id IN (SELECT lot_id FROM economy_exchange_order_gold_lots WHERE order_id=NEW.order_id AND amount_remaining=0)
      AND NOT EXISTS(SELECT 1 FROM economy_exchange_order_gold_lots r WHERE r.lot_id=economy_gold_lots.id AND r.amount_remaining>0);
  UPDATE economy_gold_lots SET remaining=remaining-COALESCE((SELECT amount FROM economy_gold_lot_transfers t WHERE t.fill_id=NEW.result_ref_id AND t.source_lot_id=economy_gold_lots.id),0),state=IIF(remaining-COALESCE((SELECT amount FROM economy_gold_lot_transfers t WHERE t.fill_id=NEW.result_ref_id AND t.source_lot_id=economy_gold_lots.id),0)=0,'spent',state) WHERE id IN (SELECT source_lot_id FROM economy_gold_lot_transfers WHERE fill_id=NEW.result_ref_id) AND (SELECT side FROM economy_exchange_orders WHERE id=NEW.order_id)='buy_gold';
  INSERT INTO economy_gold_lots(id,account_id,source,source_id,amount,remaining,state,tradeable_at,released_at,created_at)
    SELECT NEW.result_ref_id||':lot',IIF(o.side='buy_gold',o.account_id,NEW.actor_account_id),'market_transfer',NEW.result_ref_id,NEW.gold_amount,NEW.gold_amount,'available',NEW.created_at,NEW.created_at,NEW.created_at FROM economy_exchange_orders o WHERE o.id=NEW.order_id;
  UPDATE economy_exchange_orders SET gold_remaining=gold_remaining-NEW.gold_amount,ash_reserved_remaining=ash_reserved_remaining-IIF(side='buy_gold',NEW.gold_amount*NEW.price_ash,0),gold_reserved_remaining=gold_reserved_remaining-IIF(side='sell_gold',NEW.gold_amount,0),status=IIF(gold_remaining-NEW.gold_amount=0,'filled','partially_filled'),version=version+1,updated_at=NEW.created_at WHERE id=NEW.order_id;
  INSERT INTO economy_ledger(id,operation_id,account_id,currency,available_delta,reserved_delta,locked_delta,reason,reference_type,reference_id,created_at)
    SELECT NEW.id||':maker-ash',NEW.id,o.account_id,'ash',IIF(o.side='sell_gold',NEW.gold_amount*NEW.price_ash,0),IIF(o.side='buy_gold',-NEW.gold_amount*NEW.price_ash,0),0,'exchange_fill_maker_ash','exchange_fill',NEW.result_ref_id,NEW.created_at FROM economy_exchange_orders o WHERE o.id=NEW.order_id;
  INSERT INTO economy_ledger(id,operation_id,account_id,currency,available_delta,reserved_delta,locked_delta,reason,reference_type,reference_id,created_at)
    SELECT NEW.id||':maker-gold',NEW.id,o.account_id,'gold',IIF(o.side='buy_gold',NEW.gold_amount,0),IIF(o.side='sell_gold',-NEW.gold_amount,0),0,'exchange_fill_maker_gold','exchange_fill',NEW.result_ref_id,NEW.created_at FROM economy_exchange_orders o WHERE o.id=NEW.order_id;
  INSERT INTO economy_ledger(id,operation_id,account_id,currency,available_delta,reserved_delta,locked_delta,reason,reference_type,reference_id,created_at)
    SELECT NEW.id||':taker-ash',NEW.id,NEW.actor_account_id,'ash',IIF(o.side='buy_gold',NEW.gold_amount*NEW.price_ash,-NEW.gold_amount*NEW.price_ash),0,0,'exchange_fill_taker_ash','exchange_fill',NEW.result_ref_id,NEW.created_at FROM economy_exchange_orders o WHERE o.id=NEW.order_id;
  INSERT INTO economy_ledger(id,operation_id,account_id,currency,available_delta,reserved_delta,locked_delta,reason,reference_type,reference_id,created_at)
    SELECT NEW.id||':taker-gold',NEW.id,NEW.actor_account_id,'gold',IIF(o.side='sell_gold',NEW.gold_amount,-NEW.gold_amount),0,0,'exchange_fill_taker_gold','exchange_fill',NEW.result_ref_id,NEW.created_at FROM economy_exchange_orders o WHERE o.id=NEW.order_id;
  INSERT INTO economy_audit_events(id,actor_account_id,target_account_id,action,object_type,object_id,request_id,idempotency_key,request_hash,metadata_json,created_at)
    SELECT NEW.id||':audit',NEW.actor_account_id,o.account_id,'fill_exchange','exchange_fill',NEW.result_ref_id,NEW.id,NEW.idempotency_key,NEW.request_hash,'{}',NEW.created_at FROM economy_exchange_orders o WHERE o.id=NEW.order_id;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS economy_cancel_exchange_before
BEFORE INSERT ON economy_commands WHEN NEW.action = 'cancel_exchange'
BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM economy_exchange_orders WHERE id=NEW.order_id AND account_id=NEW.actor_account_id AND status IN ('open','partially_filled') AND version=NEW.expected_version) THEN RAISE(ABORT,'exchange_order_not_owned_or_version') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM economy_sanctions s WHERE s.account_id=NEW.actor_account_id AND s.revoked_at IS NULL AND s.starts_at<=NEW.created_at AND (s.expires_at IS NULL OR s.expires_at>NEW.created_at) AND s.scope IN ('exchange','wallet')) THEN RAISE(ABORT,'account_sanctioned') END;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS economy_cancel_exchange_after
AFTER INSERT ON economy_commands WHEN NEW.action = 'cancel_exchange'
BEGIN
  UPDATE economy_gold_lots SET remaining=remaining+COALESCE((SELECT amount_remaining FROM economy_exchange_order_gold_lots a WHERE a.order_id=NEW.order_id AND a.lot_id=economy_gold_lots.id),0),state='available' WHERE id IN (SELECT lot_id FROM economy_exchange_order_gold_lots WHERE order_id=NEW.order_id AND amount_remaining>0);
  UPDATE economy_exchange_order_gold_lots SET amount_remaining=0 WHERE order_id=NEW.order_id;
  UPDATE economy_wallets SET ash_available=ash_available+(SELECT ash_reserved_remaining FROM economy_exchange_orders WHERE id=NEW.order_id),ash_reserved=ash_reserved-(SELECT ash_reserved_remaining FROM economy_exchange_orders WHERE id=NEW.order_id),gold_available=gold_available+(SELECT gold_reserved_remaining FROM economy_exchange_orders WHERE id=NEW.order_id),gold_reserved=gold_reserved-(SELECT gold_reserved_remaining FROM economy_exchange_orders WHERE id=NEW.order_id),version=version+1,updated_at=NEW.created_at WHERE account_id=NEW.actor_account_id;
  INSERT INTO economy_ledger(id,operation_id,account_id,currency,available_delta,reserved_delta,locked_delta,reason,reference_type,reference_id,created_at)
    SELECT NEW.id||':release',NEW.id,NEW.actor_account_id,IIF(side='buy_gold','ash','gold'),IIF(side='buy_gold',ash_reserved_remaining,gold_reserved_remaining),IIF(side='buy_gold',-ash_reserved_remaining,-gold_reserved_remaining),0,'exchange_cancel_release','exchange_order',NEW.order_id,NEW.created_at FROM economy_exchange_orders WHERE id=NEW.order_id;
  UPDATE economy_exchange_orders SET ash_reserved_remaining=0,gold_reserved_remaining=0,status='cancelled',version=version+1,updated_at=NEW.created_at WHERE id=NEW.order_id;
  INSERT INTO economy_audit_events(id,actor_account_id,action,object_type,object_id,request_id,idempotency_key,request_hash,metadata_json,created_at)
    VALUES(NEW.id||':audit',NEW.actor_account_id,'cancel_exchange','exchange_order',NEW.order_id,NEW.id,NEW.idempotency_key,NEW.request_hash,'{}',NEW.created_at);
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS economy_sandbox_topup_before
BEFORE INSERT ON economy_commands WHEN NEW.action = 'sandbox_topup'
BEGIN
  SELECT CASE WHEN NEW.currency='ash' AND (NEW.amount IS NULL OR NEW.amount<1 OR NEW.amount>1000000000) THEN RAISE(ABORT,'invalid_sandbox_ash') END;
  SELECT CASE WHEN NEW.currency='gold' AND (NEW.amount IS NULL OR NEW.amount<1 OR NEW.amount>100000) THEN RAISE(ABORT,'invalid_sandbox_gold') END;
  SELECT CASE WHEN NEW.currency IS NULL OR NEW.currency NOT IN ('ash','gold') THEN RAISE(ABORT,'invalid_sandbox_currency') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM economy_identities WHERE account_id=NEW.actor_account_id AND provider='development') THEN RAISE(ABORT,'sandbox_development_only') END;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS economy_sandbox_topup_after
AFTER INSERT ON economy_commands WHEN NEW.action = 'sandbox_topup'
BEGIN
  UPDATE economy_wallets SET ash_available=ash_available+IIF(NEW.currency='ash',NEW.amount,0),gold_locked=gold_locked+IIF(NEW.currency='gold',NEW.amount,0),version=version+1,updated_at=NEW.created_at WHERE account_id=NEW.actor_account_id;
  INSERT INTO economy_gold_lots(id,account_id,source,source_id,amount,remaining,state,tradeable_at,created_at)
    SELECT NEW.result_ref_id,NEW.actor_account_id,'sandbox',NEW.id,NEW.amount,NEW.amount,'locked',NEW.created_at+259200000,NEW.created_at WHERE NEW.currency='gold';
  INSERT INTO economy_ledger(id,operation_id,account_id,currency,available_delta,reserved_delta,locked_delta,reason,reference_type,reference_id,created_at)
    VALUES(NEW.id||':mint',NEW.id,NEW.actor_account_id,NEW.currency,IIF(NEW.currency='ash',NEW.amount,0),0,IIF(NEW.currency='gold',NEW.amount,0),'sandbox_mint','command',NEW.id,NEW.created_at);
END;
