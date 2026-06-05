export const CODE_EXPANSION_TRANSITION: {
  type: 'tween';
  ease: [number, number, number, number];
  duration: number;
};

export function shouldEagerExpandForCodeToken(
  intent: string,
  token: string,
  previousText?: string,
): boolean;

export function shouldHoldEagerCodeExpansion(params: {
  hasCodeElements: boolean;
  hasVisibleCodeElement: boolean;
  eagerExpansionHold: boolean;
}): boolean;
