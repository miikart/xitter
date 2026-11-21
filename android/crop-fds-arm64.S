.text

.global crop_helpers
crop_helpers:
	b open_input
	b open_duplicate
	b close_streams

open_input:
	str x30, [sp, #-16]!
	bl open_duplicate
	str x0, [x29, #0x60]
	ldr x30, [sp], #16
	ret

open_duplicate:
	stp x19, x20, [sp, #-32]!
	str x30, [sp, #16]
	mov x19, x1
	bl dup_plt
	tbnz w0, #31, open_failed
	mov w20, w0
	mov x1, x19
	bl fdopen_plt
	cbnz x0, open_done
	mov w0, w20
	bl close_plt
open_failed:
	mov x0, xzr
open_done:
	ldr x30, [sp, #16]
	ldp x19, x20, [sp], #32
	ret

close_streams:
	str x30, [sp, #-16]!
	cbz x20, close_input
	mov x0, x20
	bl fclose_plt
close_input:
	ldr x0, [x29, #0x60]
	cbz x0, close_done
	bl fclose_plt
close_done:
	ldr x30, [sp], #16
	b crop_finish
