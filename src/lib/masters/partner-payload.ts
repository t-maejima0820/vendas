import type { BusinessPartnerInput, PartnerAdvisoryProfileInput } from '@/lib/masters/types';

export function parsePartnerInputBody(body: Partial<BusinessPartnerInput>): BusinessPartnerInput {
  let advisoryProfile: PartnerAdvisoryProfileInput | null = null;
  if (body.advisoryProfile !== undefined && body.advisoryProfile !== null) {
    const adv = body.advisoryProfile;
    advisoryProfile = {
      corporateNo: typeof adv.corporateNo === 'string' ? adv.corporateNo : null,
      establishedAtText: typeof adv.establishedAtText === 'string' ? adv.establishedAtText : null,
      businessDescription: typeof adv.businessDescription === 'string' ? adv.businessDescription : null,
      capitalText: typeof adv.capitalText === 'string' ? adv.capitalText : null,
      fiscalClosingMonth:
        adv.fiscalClosingMonth === null || adv.fiscalClosingMonth === undefined
          ? null
          : Number(adv.fiscalClosingMonth),
      advisoryFee: adv.advisoryFee === undefined ? 0 : Number(adv.advisoryFee),
      settlementFee: adv.settlementFee === undefined ? 0 : Number(adv.settlementFee),
      payrollClosingCode: typeof adv.payrollClosingCode === 'string' ? adv.payrollClosingCode : null,
      payrollPayCode: typeof adv.payrollPayCode === 'string' ? adv.payrollPayCode : null,
      laborInsuranceCode: typeof adv.laborInsuranceCode === 'string' ? adv.laborInsuranceCode : null,
      socialInsuranceCode: typeof adv.socialInsuranceCode === 'string' ? adv.socialInsuranceCode : null,
      laborInsuranceNo: typeof adv.laborInsuranceNo === 'string' ? adv.laborInsuranceNo : null,
      employmentInsOfficeNo: typeof adv.employmentInsOfficeNo === 'string' ? adv.employmentInsOfficeNo : null,
      pensionOfficeNo: typeof adv.pensionOfficeNo === 'string' ? adv.pensionOfficeNo : null,
      pensionSerialNo: typeof adv.pensionSerialNo === 'string' ? adv.pensionSerialNo : null,
      taxOfficeId: typeof adv.taxOfficeId === 'string' ? adv.taxOfficeId : null,
      taxOfficeSerialNo: typeof adv.taxOfficeSerialNo === 'string' ? adv.taxOfficeSerialNo : null,
      incomeTaxCode: typeof adv.incomeTaxCode === 'string' ? adv.incomeTaxCode : null,
      consumptionTaxCode: typeof adv.consumptionTaxCode === 'string' ? adv.consumptionTaxCode : null,
      residentTaxCode: typeof adv.residentTaxCode === 'string' ? adv.residentTaxCode : null,
      taxTransferInfo: typeof adv.taxTransferInfo === 'string' ? adv.taxTransferInfo : null,
      laborBankAccount: typeof adv.laborBankAccount === 'string' ? adv.laborBankAccount : null,
      socialBankAccount: typeof adv.socialBankAccount === 'string' ? adv.socialBankAccount : null,
    };
  }

  return {
    partnerCode: typeof body.partnerCode === 'string' ? body.partnerCode : '',
    categoryCode: typeof body.categoryCode === 'string' ? body.categoryCode : null,
    stateCode: typeof body.stateCode === 'string' ? body.stateCode : null,
    partnerName: typeof body.partnerName === 'string' ? body.partnerName : '',
    furigana: typeof body.furigana === 'string' ? body.furigana : null,
    representativeId: typeof body.representativeId === 'string' ? body.representativeId : null,
    isIndividualHonorific: Boolean(body.isIndividualHonorific),
    postalCode: typeof body.postalCode === 'string' ? body.postalCode : null,
    address1: typeof body.address1 === 'string' ? body.address1 : null,
    address2: typeof body.address2 === 'string' ? body.address2 : null,
    tel: typeof body.tel === 'string' ? body.tel : null,
    isClient: body.isClient === undefined ? true : Boolean(body.isClient),
    isSupplier: Boolean(body.isSupplier),
    isAplusEnabled: Boolean(body.isAplusEnabled),
    sendMailEnabled: Boolean(body.sendMailEnabled),
    email: typeof body.email === 'string' ? body.email : null,
    estimateMailTo: typeof body.estimateMailTo === 'string' ? body.estimateMailTo : null,
    estimateMailCc: typeof body.estimateMailCc === 'string' ? body.estimateMailCc : null,
    billMailTo: typeof body.billMailTo === 'string' ? body.billMailTo : null,
    billMailCc: typeof body.billMailCc === 'string' ? body.billMailCc : null,
    invoiceNo: typeof body.invoiceNo === 'string' ? body.invoiceNo : null,
    billingDestinationName: typeof body.billingDestinationName === 'string' ? body.billingDestinationName : null,
    closingDayCode: typeof body.closingDayCode === 'string' ? body.closingDayCode : null,
    collectionDayCode: typeof body.collectionDayCode === 'string' ? body.collectionDayCode : null,
    receiptMethodCode: typeof body.receiptMethodCode === 'string' ? body.receiptMethodCode : null,
    paymentMethodCode: typeof body.paymentMethodCode === 'string' ? body.paymentMethodCode : null,
    assignedEmployeeId: typeof body.assignedEmployeeId === 'string' ? body.assignedEmployeeId : null,
    openingArBalance: body.openingArBalance === undefined ? undefined : Number(body.openingArBalance),
    openingApBalance: body.openingApBalance === undefined ? undefined : Number(body.openingApBalance),
    bankCode: typeof body.bankCode === 'string' ? body.bankCode : null,
    branchCode: typeof body.branchCode === 'string' ? body.branchCode : null,
    bankAccountType:
      body.bankAccountType === 'B1' || body.bankAccountType === 'B2' ? body.bankAccountType : null,
    bankAccountNo: typeof body.bankAccountNo === 'string' ? body.bankAccountNo : null,
    bankAccountHolder: typeof body.bankAccountHolder === 'string' ? body.bankAccountHolder : null,
    isDeleted: Boolean(body.isDeleted),
    advisoryProfile,
  };
}
