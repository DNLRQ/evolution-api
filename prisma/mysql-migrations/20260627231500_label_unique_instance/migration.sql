-- Índice único labelId+instanceId (requerido por label.upsert en Baileys)
CREATE UNIQUE INDEX `Label_labelId_instanceId_key` ON `Label`(`labelId`, `instanceId`);
