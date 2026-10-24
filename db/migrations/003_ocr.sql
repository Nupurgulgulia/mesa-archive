-- Step 3: record how text was obtained, so OCR-derived text (may contain recognition errors) is visible.
alter table doc_extractions add column if not exists method text not null default 'text';  -- text | ocr
alter table doc_extractions add column if not exists ocr_confidence numeric(5,1);           -- mean Tesseract confidence 0-100
alter table doc_chunks add column if not exists is_ocr boolean not null default false;
