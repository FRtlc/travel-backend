/**
 * 腾讯云 SMS 短信服务模块
 * 
 * 使用前需要：
 * 1. 登录腾讯云控制台 https://console.cloud.tencent.com/smsv2
 * 2. 创建短信签名（如"游指南"），等待审核通过（1-2个工作日）
 * 3. 创建短信正文模板（如"您的验证码为{1}，{2}分钟内有效..."），等待审核通过
 * 4. 获取 SmsSdkAppId（在"应用管理"中创建应用后获得）
 * 5. 在腾讯云 API 密钥管理 https://console.cloud.tencent.com/cam/capi 获取 SecretId 和 SecretKey
 * 6. 将以上信息填入 .env 文件或环境变量
 * 
 * 环境变量配置（.env 文件）：
 * TENCENT_SECRET_ID=your_secret_id
 * TENCENT_SECRET_KEY=your_secret_key
 * TENCENT_SMS_SDK_APP_ID=your_sdk_app_id
 * TENCENT_SMS_SIGN_NAME=游指南
 * TENCENT_SMS_TEMPLATE_ID=your_template_id
 */

let smsClient = null;
let smsConfig = null;

/**
 * 初始化 SMS 客户端
 */
function initSMS() {
    const secretId = process.env.TENCENT_SECRET_ID;
    const secretKey = process.env.TENCENT_SECRET_KEY;
    const sdkAppId = process.env.TENCENT_SMS_SDK_APP_ID;
    const signName = process.env.TENCENT_SMS_SIGN_NAME;
    const templateId = process.env.TENCENT_SMS_TEMPLATE_ID;

    if (!secretId || !secretKey || !sdkAppId || !signName || !templateId) {
        console.log('[SMS] 未配置腾讯云短信凭证，将使用开发模式（验证码打印到控制台）');
        console.log('[SMS] 配置方法：设置环境变量 TENCENT_SECRET_ID, TENCENT_SECRET_KEY, TENCENT_SMS_SDK_APP_ID, TENCENT_SMS_SIGN_NAME, TENCENT_SMS_TEMPLATE_ID');
        return false;
    }

    try {
        const tencentcloud = require('tencentcloud-sdk-nodejs');
        const SmsClient = tencentcloud.sms.v20210111.Client;

        smsClient = new SmsClient({
            credential: {
                secretId: secretId,
                secretKey: secretKey,
            },
            region: 'ap-guangzhou',
            profile: {
                httpProfile: {
                    endpoint: 'sms.tencentcloudapi.com',
                    reqTimeout: 10,
                },
            },
        });

        smsConfig = { sdkAppId, signName, templateId };
        console.log('[SMS] 腾讯云短信服务已初始化');
        console.log('[SMS] 签名:', signName, '| 模板ID:', templateId, '| 应用ID:', sdkAppId);
        return true;
    } catch (e) {
        console.warn('[SMS] 腾讯云短信 SDK 加载失败:', e.message);
        return false;
    }
}

/**
 * 发送验证码短信
 * @param {string} phone - 手机号（11位，如 13800138000）
 * @param {string} code - 验证码（6位数字）
 * @param {number} expireMinutes - 过期时间（分钟）
 * @returns {Promise<{success: boolean, msgId?: string, error?: string}>}
 */
async function sendVerifyCodeSMS(phone, code, expireMinutes) {
    expireMinutes = expireMinutes || 5;

    if (!smsClient || !smsConfig) {
        // 开发模式：不发送真实短信
        console.log('[SMS] [开发模式] 验证码: ' + phone + ' -> ' + code);
        return { success: true, dev_mode: true, msg: '开发模式：验证码已打印到控制台' };
    }

    try {
        // 手机号格式：国内需加 +86 前缀
        const phoneNumber = phone.startsWith('+86') ? phone : '+86' + phone;

        const params = {
            SmsSdkAppId: smsConfig.sdkAppId,
            SignName: smsConfig.signName,
            TemplateId: smsConfig.templateId,
            // 模板参数：{1}=验证码, {2}=过期分钟数
            TemplateParamSet: [code, String(expireMinutes)],
            PhoneNumberSet: [phoneNumber],
        };

        const response = await smsClient.SendSms(params);

        if (response.SendStatusSet && response.SendStatusSet.length > 0) {
            const status = response.SendStatusSet[0];
            if (status.Code === 'Ok') {
                console.log('[SMS] 短信发送成功: ' + phone + ' (MsgId: ' + status.SerialNo + ')');
                return { success: true, msgId: status.SerialNo };
            } else {
                console.error('[SMS] 短信发送失败: ' + phone + ' - ' + status.Code + ': ' + status.Message);
                return { success: false, error: status.Message || status.Code };
            }
        } else {
            return { success: false, error: '短信服务返回异常' };
        }
    } catch (e) {
        console.error('[SMS] 短信发送异常:', e.message);
        return { success: false, error: e.message };
    }
}

/**
 * 发送通用短信
 * @param {string} phone - 手机号
 * @param {string} templateId - 模板 ID
 * @param {string[]} params - 模板参数
 * @returns {Promise<{success: boolean, msgId?: string, error?: string}>}
 */
async function sendSMS(phone, templateId, params) {
    if (!smsClient || !smsConfig) {
        console.log('[SMS] [开发模式] 通知短信: ' + phone);
        return { success: true, dev_mode: true };
    }

    try {
        const phoneNumber = phone.startsWith('+86') ? phone : '+86' + phone;
        const response = await smsClient.SendSms({
            SmsSdkAppId: smsConfig.sdkAppId,
            SignName: smsConfig.signName,
            TemplateId: templateId,
            TemplateParamSet: params || [],
            PhoneNumberSet: [phoneNumber],
        });

        if (response.SendStatusSet && response.SendStatusSet.length > 0) {
            const status = response.SendStatusSet[0];
            if (status.Code === 'Ok') {
                return { success: true, msgId: status.SerialNo };
            } else {
                return { success: false, error: status.Message || status.Code };
            }
        }
        return { success: false, error: '未知错误' };
    } catch (e) {
        console.error('[SMS] 短信发送异常:', e.message);
        return { success: false, error: e.message };
    }
}

module.exports = {
    initSMS,
    sendVerifyCodeSMS,
    sendSMS,
    isReady: () => !!smsClient,
};
