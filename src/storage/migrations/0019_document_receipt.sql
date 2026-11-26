-- Bind the issued document to exactly one receipt rather than an interchangeable file hash.
ALTER TABLE standalone_delivery ADD COLUMN report_receipt_id TEXT;
