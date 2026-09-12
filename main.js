// ============================================================
// PixiJS
// ============================================================
const { Application, live2d: { Live2DModel } } = PIXI;

// ============================================================
// Kalidokit
// ============================================================
const {
    Face,
    Vector: { lerp },
    Utils: { clamp }
} = Kalidokit;


// ============================================================
// 基本設定
// ============================================================

const modelUrl = "./hiyori/hiyori_pro_t10.model3.json";
const videoElement = document.getElementById("my-video");
const canvasElement = document.getElementById("my-live2d");

let currentModel = null;
let facemesh = null;

// Face tracking
let latestRiggedFace = null;
let smoothRiggedFace = null;

// ============================================================
// モーション管理
// ============================================================

// true = キーによるモーション再生中
let isPlayingMotion = false;

// 0 = モーション優先 / 1 = トラッキング完全復帰
let motionBlendFactor = 1;


// ============================================================
// メイン処理
// ============================================================

(async function main() {

    // --------------------------------------------------------
    // 1. PixiJS (背景完全透過設定)
    // --------------------------------------------------------

    const app = new PIXI.Application({
        view: canvasElement,
        autoStart: true,
        backgroundAlpha: 0,      // アルファ値を0にして完全に透明化
        transparent: true,          // 互換性用の透明設定
        clearBeforeRender: true,    // 描画ごとにクリア
        resizeTo: window
    });

    // PixiJS レンダラーの背景クリアフラグを確実にONにする
    if (app.renderer.background) {
        app.renderer.background.clearBeforeRender = true;
    }

    // --------------------------------------------------------
    // 2. Live2Dモデル読み込み
    // --------------------------------------------------------

    currentModel = await Live2DModel.from(modelUrl, {
        autoInteract: false
    });


    // --------------------------------------------------------
    // ★自動再生される待機モーションを停止
    // --------------------------------------------------------

    const motionManager = currentModel.internalModel.motionManager;

    if (motionManager) {
        try {
            motionManager.stopAllMotions();
        } catch (error) {
            console.warn("初期モーション停止時にエラー:", error);
        }
    }


    // --------------------------------------------------------
    // モデル設定
    // --------------------------------------------------------

    currentModel.scale.set(0.4);
    currentModel.interactive = true;
    currentModel.anchor.set(0.5, 0.5);

    currentModel.position.set(
        window.innerWidth * 0.5,
        window.innerHeight * 0.8
    );


    // --------------------------------------------------------
    // ドラッグ移動
    // --------------------------------------------------------

    currentModel.on("pointerdown", e => {
        currentModel.offsetX = e.data.global.x - currentModel.position.x;
        currentModel.offsetY = e.data.global.y - currentModel.position.y;
        currentModel.dragging = true;
    });

    currentModel.on("pointerup", () => {
        currentModel.dragging = false;
    });

    currentModel.on("pointerupoutside", () => {
        currentModel.dragging = false;
    });

    currentModel.on("pointermove", e => {
        if (!currentModel.dragging) return;
        currentModel.position.set(
            e.data.global.x - currentModel.offsetX,
            e.data.global.y - currentModel.offsetY
        );
    });


    // --------------------------------------------------------
    // マウスホイールで拡大・縮小
    // --------------------------------------------------------

    canvasElement.addEventListener("wheel", e => {
        e.preventDefault();
        const newScale = clamp(
            currentModel.scale.x + e.deltaY * -0.001,
            0.1,
            3.0
        );
        currentModel.scale.set(newScale);
    }, { passive: false });


    // --------------------------------------------------------
    // ステージに追加
    // --------------------------------------------------------

    app.stage.addChild(currentModel);


    // --------------------------------------------------------
    // モーション終了イベント
    // --------------------------------------------------------

    if (motionManager) {
        motionManager.on("motionFinish", () => {
            console.log("モーション終了");
            isPlayingMotion = false;
            motionBlendFactor = 0; // トラッキング復帰開始
        });
    }


    // --------------------------------------------------------
    // 3. 数字キーでモーション再生
    // --------------------------------------------------------

    window.addEventListener("keydown", e => {
        if (e.repeat) return;
        if (!currentModel) return;

        switch (e.key) {
            case "1": playCustomMotion("", 0); break;
            case "2": playCustomMotion("", 1); break;
            case "3": playCustomMotion("", 2); break;
            case "4": playCustomMotion("", 3); break;
            case "5": playCustomMotion("", 4); break;
            case "6": playCustomMotion("", 5); break;
            case "7": playCustomMotion("", 6); break;
            case "8": playCustomMotion("", 7); break;
            case "9": playCustomMotion("", 8); break;
            case "0": playCustomMotion("", 9); break;
        }
    });


    // ========================================================
    // 4. 毎フレーム処理
    // ========================================================

    app.ticker.add(delta => {
        if (!currentModel) return;

        const motionManager = currentModel.internalModel.motionManager;
        let isExecutingMotion = false;

        if (isPlayingMotion) {
            if (motionManager && typeof motionManager.isFinished === "function") {
                isExecutingMotion = !motionManager.isFinished();
            } else {
                isExecutingMotion = true;
            }
        }

        // モーション再生中
        if (isPlayingMotion && isExecutingMotion) {
            return;
        }

        // モーション終了検知
        if (isPlayingMotion && !isExecutingMotion) {
            isPlayingMotion = false;
            motionBlendFactor = 0;
        }

        // トラッキング復帰フェード
        if (motionBlendFactor < 1) {
            motionBlendFactor = Math.min(
                1,
                motionBlendFactor + 0.05 * delta
            );
        }

        // Face trackingの適用
        if (latestRiggedFace) {
            smoothRiggedFace = smoothFaceData(
                smoothRiggedFace,
                latestRiggedFace,
                0.25 * delta
            );

            applyRig(
                currentModel,
                smoothRiggedFace,
                0.2 * delta,
                motionBlendFactor
            );
        }
    });


    // ========================================================
    // 5. MediaPipe FaceMesh
    // ========================================================

    facemesh = new FaceMesh({
        locateFile: file => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`
    });

    facemesh.setOptions({
        maxNumFaces: 1,
        refineLandmarks: true,
        minDetectionConfidence: 0.5,
        minTrackingConfidence: 0.5
    });

    facemesh.onResults(onResults);


    // ========================================================
    // 6. カメラ開始
    // ========================================================

    startCamera();

})();


// ============================================================
// モーション再生
// ============================================================

const playCustomMotion = async (group, index = 0) => {
    if (!currentModel) return;

    const motionManager = currentModel.internalModel.motionManager;
    if (!motionManager) return;

    console.log(`モーション再生: index=${index}`);

    try {
        motionManager.stopAllMotions();
    } catch (error) {
        console.warn("既存モーション停止エラー:", error);
    }

    isPlayingMotion = true;
    motionBlendFactor = 0;

    try {
        const success = await motionManager.startMotion(group, index, 3, false);
        if (!success) {
            console.warn(`モーション再生失敗: index=${index}`);
            isPlayingMotion = false;
            motionBlendFactor = 1;
        }
    } catch (error) {
        console.error("モーション再生エラー:", error);
        isPlayingMotion = false;
        motionBlendFactor = 1;
    }
};


// ============================================================
// MediaPipe結果
// ============================================================

const onResults = results => {
    const points = results.multiFaceLandmarks ? results.multiFaceLandmarks[0] : null;

    if (points) {
        latestRiggedFace = Face.solve(points, {
            runtime: "mediapipe",
            video: videoElement
        });
    } else {
        latestRiggedFace = null;
    }
};


// ============================================================
// Faceデータ平滑化 (EMAフィルター)
// ============================================================

const smoothFaceData = (oldData, newData, factor) => {
    if (!oldData) return newData;

    const f = clamp(factor, 0.05, 1);

    return {
        pupil: {
            x: lerp(oldData.pupil.x, newData.pupil.x, f),
            y: lerp(oldData.pupil.y, newData.pupil.y, f)
        },
        head: {
            degrees: {
                x: lerp(oldData.head.degrees.x, newData.head.degrees.x, f),
                y: lerp(oldData.head.degrees.y, newData.head.degrees.y, f),
                z: lerp(oldData.head.degrees.z, newData.head.degrees.z, f)
            },
            y: lerp(oldData.head.y, newData.head.y, f)
        },
        eye: {
            l: lerp(oldData.eye.l, newData.eye.l, f),
            r: lerp(oldData.eye.r, newData.eye.r, f)
        },
        mouth: {
            x: lerp(oldData.mouth.x, newData.mouth.x, f),
            y: lerp(oldData.mouth.y, newData.mouth.y, f)
        }
    };
};


// ============================================================
// Live2DへFace trackingを反映
// ============================================================

const applyRig = (model, result, lerpAmount, blendFactor = 1) => {
    const coreModel = model.internalModel.coreModel;

    // 自動まばたきをOFF
    model.internalModel.eyeBlink = undefined;

    const setParam = (id, targetVal) => {
        const currentVal = coreModel.getParameterValueById(id);
        const finalTarget = lerp(currentVal, targetVal, blendFactor);
        coreModel.setParameterValueById(
            id,
            lerp(currentVal, finalTarget, lerpAmount)
        );
    };

    // 視線
    setParam("ParamEyeBallX", result.pupil.x);
    setParam("ParamEyeBallY", result.pupil.y);

    // 頭部回転
    setParam("ParamAngleX", -result.head.degrees.y);
    setParam("ParamAngleY", result.head.degrees.x);
    setParam("ParamAngleZ", -result.head.degrees.z);

    // 体の連動
    const dampener = 0.3;
    setParam("ParamBodyAngleX", -result.head.degrees.y * dampener);
    setParam("ParamBodyAngleY", result.head.degrees.x * dampener);
    setParam("ParamBodyAngleZ", -result.head.degrees.z * dampener);

    // 目
    const currentEyeL = coreModel.getParameterValueById("ParamEyeLOpen");
    const currentEyeR = coreModel.getParameterValueById("ParamEyeROpen");

    const stabilizedEyes = Face.stabilizeBlink(
        {
            l: lerp(currentEyeL, result.eye.l, lerpAmount),
            r: lerp(currentEyeR, result.eye.r, lerpAmount)
        },
        result.head.y
    );

    setParam("ParamEyeLOpen", stabilizedEyes.l);
    setParam("ParamEyeROpen", stabilizedEyes.r);

    // 口
    setParam("ParamMouthOpenY", result.mouth.y);
    setParam("ParamMouthForm", 0.3 + result.mouth.x);
};


// ============================================================
// Webカメラ起動
// ============================================================

const startCamera = () => {
    const camera = new Camera(videoElement, {
        onFrame: async () => {
            if (!facemesh) return;
            await facemesh.send({ image: videoElement });
        },
        width: 640,
        height: 480
    });

    camera.start();
};
