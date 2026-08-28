<script setup lang="ts">
import {DeviceRecord} from '../../types/Device'

const props = defineProps<{
    device: DeviceRecord
}>()

const emit = defineEmits<{
    (e: 'camera'): void
}>()

const doOpenCamera = () => {
    emit('camera')
}
</script>

<template>
    <a-doption @click="doOpenCamera">
        <template #icon>
            <i-lucide-camera />
        </template>
        {{ $t('device.openCamera') }}
    </a-doption>
</template>
