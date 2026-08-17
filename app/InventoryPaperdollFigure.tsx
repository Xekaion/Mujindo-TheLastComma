import type { CSSProperties } from "react";
import {
  GEAR_ICON_COLUMNS,
  GEAR_ICON_ROWS,
  type EquipmentLoadout,
} from "./equipment";
import {
  INVENTORY_PORTRAIT_BASE_PATH,
  INVENTORY_PORTRAIT_FITTED_ARMOR_PATH,
  INVENTORY_PORTRAIT_GEAR_ATLAS_PATH,
  createInventoryPortraitSignature,
  inventoryPortraitAppearanceLabel,
  inventoryPortraitPieces,
  inventoryPortraitVariantHue,
  isInventoryPortraitFittedSlot,
  strongestInventoryPortraitRarity,
} from "./inventory-paperdoll-portrait";

export type InventoryPaperdollFigureProps = Readonly<{
  equipment: EquipmentLoadout;
}>;

/**
 * Inventory-only illustrated equipment mannequin.
 *
 * Combat and plaza paperdolls intentionally use small directional animation
 * atlases. This screen instead keeps a fixed orthographic human proportion
 * study and composes fitted armour layers plus the equipped held-item artwork
 * over their anatomical slots. It never samples a walk direction or movement
 * frame.
 */
export default function InventoryPaperdollFigure({
  equipment,
}: InventoryPaperdollFigureProps) {
  const portraitSignature = createInventoryPortraitSignature(equipment);
  const portraitRarity = strongestInventoryPortraitRarity(equipment);
  const portraitLabel = inventoryPortraitAppearanceLabel(equipment);
  const pieces = inventoryPortraitPieces(equipment);

  return (
    <div
      className="inventory-screen-paperdoll-figure is-ready"
      data-paperdoll-rarity={portraitRarity}
      data-portrait-mode="illustrated"
      role="img"
      aria-label={portraitLabel}
    >
      <span className="inventory-screen-paperdoll-proportion-guide" aria-hidden="true" />
      <span
        key={portraitSignature}
        className="inventory-screen-paperdoll-stage is-swapping"
        aria-hidden="true"
      >
        <span
          className="inventory-screen-paperdoll-base"
          style={{ backgroundImage: `url('${INVENTORY_PORTRAIT_BASE_PATH}')` }}
        />
        {pieces.map(({ slot, item, row, backgroundX, backgroundY, geometry }) => {
          if (isInventoryPortraitFittedSlot(slot)) {
            const fittedStyle = {
              zIndex: geometry.zIndex,
              backgroundImage: `url('${INVENTORY_PORTRAIT_FITTED_ARMOR_PATH}')`,
              "--inventory-portrait-variant-hue": `${inventoryPortraitVariantHue(row)}deg`,
            } satisfies CSSProperties & Record<"--inventory-portrait-variant-hue", string>;
            return (
              <span
                key={`${slot}:${item.id}:${item.iconIndex}`}
                className={`inventory-screen-paperdoll-fitted-piece inventory-screen-paperdoll-fitted-piece--${slot}`}
                data-portrait-slot={slot}
                data-rarity={item.rarity}
                style={{ zIndex: geometry.zIndex }}
              >
                <span
                  className={`inventory-screen-paperdoll-fitted-layer inventory-screen-paperdoll-fitted-layer--${slot}`}
                  style={fittedStyle}
                />
                {slot === "gloves" && (
                  <span
                    className="inventory-screen-paperdoll-fitted-layer inventory-screen-paperdoll-fitted-layer--gloves-right"
                    style={fittedStyle}
                  />
                )}
              </span>
            );
          }
          const style = {
            left: `${geometry.left}%`,
            top: `${geometry.top}%`,
            width: `${geometry.width}%`,
            zIndex: geometry.zIndex,
            backgroundImage: `url('${INVENTORY_PORTRAIT_GEAR_ATLAS_PATH}')`,
            backgroundRepeat: "no-repeat",
            backgroundSize: `${GEAR_ICON_COLUMNS * 100}% ${GEAR_ICON_ROWS * 100}%`,
            backgroundPosition: `${backgroundX}% ${backgroundY}%`,
            transform: `rotate(${geometry.rotation}deg)`,
          } satisfies CSSProperties;
          return (
            <span
              key={`${slot}:${item.id}:${item.iconIndex}`}
              className={`inventory-screen-paperdoll-piece inventory-screen-paperdoll-piece--${slot}`}
              data-portrait-slot={slot}
              data-rarity={item.rarity}
              style={style}
            />
          );
        })}
      </span>
    </div>
  );
}
