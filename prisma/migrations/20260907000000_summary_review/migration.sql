-- AlterEnum
-- Новые стадии для экрана итоговой анкеты и правки отдельных ответов.
ALTER TYPE "Stage" ADD VALUE 'SUMMARY_REVIEW';
ALTER TYPE "Stage" ADD VALUE 'EDIT_PICK_QUESTION';
ALTER TYPE "Stage" ADD VALUE 'EDIT_ANSWER';
ALTER TYPE "Stage" ADD VALUE 'EDIT_MORE';
