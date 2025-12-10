export const PaymentOrderFunctions = {
	generateCustomRetailerId: () => {
		return 'custom-item-' + Math.floor(Math.random() * 1000000000)
	},
	generateReferenceId: () => {
		return Math.random().toString(36).substring(2, 11).toUpperCase()
	}
}