-- Restaura columna lid (eliminada por migración kafka en MySQL)
ALTER TABLE `IsOnWhatsapp` ADD COLUMN `lid` VARCHAR(100) NULL;
